import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
} from './identity.ts';
import { defaultMaintenancePolicy } from './platform-maintenance-contracts.ts';
import {
  listMaintenanceDeployments,
  registerMaintenanceDeployment,
  updateMaintenanceDeployment,
  rotateMaintenanceCredential,
  MaintenanceConflict,
} from './platform-maintenance.ts';
import {
  createPlatformRepositoryMerge,
  startRepositoryMergeEffect,
} from './platform-repository-merges.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('central maintenance configuration, isolation and write boundary', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    admin: RequestContext,
    other: RequestContext,
    ordinary: RequestContext;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
    async function principal(email: string) {
      const p = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Internal',
        workspaceSlug: 'control-plane',
        workspaceName: 'Internal',
        email,
        displayName: 'Maintenance fixture',
        role: 'member',
      });
      return (await authenticateSession(
        (await createSession(p.user.id)).token,
      ))!;
    }
    admin = await principal('maintenance-admin@example.test');
    other = await principal('maintenance-other@example.test');
    ordinary = await principal('maintenance-member@example.test');
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      'maintenance-admin@example.test,maintenance-other@example.test',
    );
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });
  const request = () => ({
    requestId: randomUUID(),
    companySlug: 'fixture-company',
    companyName: 'Fixture Company',
    deploymentName: 'Primary',
  });
  it('commits a report-only installation once and never leaks its key in readback, database or audit', async () => {
    const input = request(),
      created = await registerMaintenanceDeployment(admin, input);
    expect(created.deployment.policy).toEqual(defaultMaintenancePolicy);
    expect(created.installationKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const replay = await registerMaintenanceDeployment(admin, input);
    expect(replay).toEqual({
      deployment: created.deployment,
      installationKey: null,
    });
    await expect(
      registerMaintenanceDeployment(admin, {
        ...input,
        companyName: 'Changed',
      }),
    ).rejects.toBeInstanceOf(MaintenanceConflict);
    const catalog = await listMaintenanceDeployments(admin);
    expect(catalog.deployments).toEqual([created.deployment]);
    expect(catalog.capabilities).toEqual({
      repairReady: false,
      automaticMerge: false,
      automaticDeployment: false,
      globalRepairConcurrency: 1,
    });
    const rows =
      await fixture.db`select * from allrice_platform_maintenance_deployments`;
    const audit =
      await fixture.db`select metadata from allrice_audit_events where resource_id=${created.deployment.id}`;
    expect(JSON.stringify([rows, audit, catalog])).not.toContain(
      created.installationKey,
    );
    expect(rows[0]!.credential_digest).toBe(
      createHash('sha256').update(created.installationKey!).digest('hex'),
    );
    expect(audit).toHaveLength(1);
    expect((await listMaintenanceDeployments(other)).deployments).toEqual([]);
    await expect(
      updateMaintenanceDeployment(other, created.deployment.id, {
        expectedRevision: 1,
        policy: defaultMaintenancePolicy,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
  it('serializes different request IDs targeting the same deployment and prevents CAS overwrites', async () => {
    const results = await Promise.allSettled([
      registerMaintenanceDeployment(admin, {
        ...request(),
        deploymentName: 'Concurrent',
      }),
      registerMaintenanceDeployment(admin, {
        ...request(),
        deploymentName: 'Concurrent',
      }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
    const d = (await listMaintenanceDeployments(admin)).deployments.find(
      (d) => d.deploymentName === 'Concurrent',
    )!;
    const updates = await Promise.allSettled([
      updateMaintenanceDeployment(admin, d.id, {
        expectedRevision: 1,
        policy: { ...defaultMaintenancePolicy, paused: true },
      }),
      updateMaintenanceDeployment(admin, d.id, {
        expectedRevision: 1,
        policy: { ...defaultMaintenancePolicy, checkIntervalMinutes: 120 },
      }),
    ]);
    expect(updates.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(updates.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect(
      (await listMaintenanceDeployments(admin)).deployments.find(
        (x) => x.id === d.id,
      )!.revision,
    ).toBe(2);
  });
  it('recovers a lost installation response by rotating, and fences the previous credential and stale retries', async () => {
    const d = await registerMaintenanceDeployment(admin, {
      ...request(),
      deploymentName: 'Credential lifecycle',
    });
    const rotated = await rotateMaintenanceCredential(admin, d.deployment.id, {
      expectedRevision: 1,
      action: 'rotate',
    });
    expect(rotated.installationKey).not.toBe(d.installationKey);
    expect(rotated.deployment).toMatchObject({
      revision: 2,
      credentialRevision: 2,
      revokedAt: null,
    });
    await expect(
      rotateMaintenanceCredential(admin, d.deployment.id, {
        expectedRevision: 1,
        action: 'rotate',
      }),
    ).rejects.toBeInstanceOf(MaintenanceConflict);
    const revoked = await rotateMaintenanceCredential(admin, d.deployment.id, {
      expectedRevision: 2,
      action: 'revoke',
    });
    expect(revoked.installationKey).toBeNull();
    expect(revoked.deployment.revokedAt).not.toBeNull();
    const [row] =
      await fixture.db`select credential_digest from allrice_platform_maintenance_deployments where id=${d.deployment.id}`;
    expect(row!.credential_digest).not.toBe(
      createHash('sha256').update(rotated.installationKey!).digest('hex'),
    );
    const restored = await rotateMaintenanceCredential(admin, d.deployment.id, {
      expectedRevision: 3,
      action: 'rotate',
    });
    expect(restored.deployment).toMatchObject({
      revision: 4,
      credentialRevision: 4,
      revokedAt: null,
    });
  });
  it('rejects unready automatic modes, ordinary accounts and stale or revoked sessions', async () => {
    const d = (await listMaintenanceDeployments(admin)).deployments[0]!;
    await expect(
      updateMaintenanceDeployment(admin, d.id, {
        expectedRevision: d.revision,
        policy: {
          ...defaultMaintenancePolicy,
          mode: 'repair_and_pr',
          automaticAuthorizationUntil: new Date(
            Date.now() + 3600000,
          ).toISOString(),
        },
      }),
    ).rejects.toMatchObject({ code: 'grant_invalid' });
    await expect(
      registerMaintenanceDeployment(ordinary, request()),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      listMaintenanceDeployments({ ...admin, sessionId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      registerMaintenanceDeployment(
        { ...admin, authenticatedAt: new Date(0).toISOString() },
        request(),
      ),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await fixture.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${other.sessionId!}`;
    await expect(
      registerMaintenanceDeployment(other, request()),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('rejects direct/internal merge and ready intents before touching a repository or job', async () => {
    await expect(
      createPlatformRepositoryMerge(admin, {
        requestId: randomUUID(),
        action: 'merge',
        publicationId: randomUUID(),
        reviewSubjectId: randomUUID(),
        expectedSubjectDigest: 'sha256:' + 'a'.repeat(64),
        credentialRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    for (const step of ['ready', 'merge'] as const)
      await expect(
        startRepositoryMergeEffect(
          {
            jobId: randomUUID(),
            leaseToken: randomUUID(),
            workerId: 'fixture',
            attempt: 1,
          },
          step,
          {},
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(
      await fixture.db`select id from allrice_platform_repository_merge_actions`,
    ).toHaveLength(0);
  });
  it('rolls back configuration and credential writes if a login expires while waiting for a lock', async () => {
    for (const action of ['register', 'update', 'rotate'] as const) {
      const session = await createSession(admin.actor.id),
        context = (await authenticateSession(session.token))!;
      const created = await registerMaintenanceDeployment(admin, {
        ...request(),
        deploymentName: `Expiry ${action}`,
      });
      let entered!: () => void, release!: () => void;
      const held = new Promise<void>((done) => {
          entered = done;
        }),
        until = new Promise<void>((done) => {
          release = done;
        });
      const hold = fixture.db.begin(async (tx) => {
        if (action === 'register')
          await tx`select pg_advisory_xact_lock(hashtext(${`maintenance-register:${admin.actor.id}`}))`;
        else
          await tx`select id from allrice_platform_maintenance_deployments where id=${created.deployment.id} for update`;
        entered();
        await until;
      });
      await held;
      await fixture.db`update allrice_sessions set expires_at=clock_timestamp()+interval '1 second' where id=${context.sessionId!}`;
      const write = (
        action === 'register'
          ? registerMaintenanceDeployment(context, {
              ...request(),
              deploymentName: 'Expired rejected',
            })
          : action === 'update'
            ? updateMaintenanceDeployment(context, created.deployment.id, {
                expectedRevision: 1,
                policy: { ...defaultMaintenancePolicy, paused: true },
              })
            : rotateMaintenanceCredential(context, created.deployment.id, {
                expectedRevision: 1,
                action: 'rotate',
              })
      ).then(
        () => ({ allowed: true }),
        (error) => ({ allowed: false, error }),
      );
      try {
        await vi.waitFor(
          async () => {
            const [row] =
              await fixture.db`select expires_at<=clock_timestamp() as expired from allrice_sessions where id=${context.sessionId!}`;
            expect(row!.expired).toBe(true);
          },
          { timeout: 5000, interval: 50 },
        );
        release();
        await hold;
        expect(await write).toMatchObject({
          allowed: false,
          error: { code: 'authorization_denied' },
        });
        expect(
          (await listMaintenanceDeployments(admin)).deployments.find(
            (d) => d.id === created.deployment.id,
          )!.revision,
        ).toBe(1);
      } finally {
        release();
        await hold;
        await write;
      }
    }
  }, 15000);
});
