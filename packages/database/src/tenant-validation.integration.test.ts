import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect, describe, vi } from 'vitest';
import * as client from './core/client.ts';
import * as quotas from './tenant-quotas.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { tenantValidationFixture } from './tenant-validation.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticateSession,
  revokeSession,
} from './identity.ts';
import {
  getTenantValidationSummary,
  inspectTenantRun,
} from './tenant-validation.ts';
import { inspectTenantRunArtifacts } from './artifact-review.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('MET-151 PR4 scoped inspection (isolated PostgreSQL)', () => {
  let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let a: Awaited<ReturnType<typeof tenantValidationFixture>>, b: typeof a;
  let admin: NonNullable<Awaited<ReturnType<typeof authenticateSession>>>;
  let adminToken: string;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    f = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    const slug = `v-${randomUUID()}`,
      p = await ensureBootstrapPortalPrincipal(
        {
          organizationSlug: slug,
          organizationName: slug,
          workspaceSlug: 'default',
          workspaceName: 'Default',
          email: `${slug}@example.test`,
          displayName: slug,
          role: 'admin',
        },
        f.db,
      );
    const session = await createSession(p.user.id);
    adminToken = session.token;
    admin = (await authenticateSession(session.token))!;
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', p.user.email);
    a = await tenantValidationFixture(f.db);
    b = await tenantValidationFixture(f.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (f) await f.close();
  });
  it('shows assigned versions and only the exact member runs without granting membership', async () => {
    const s = await getTenantValidationSummary(admin, a.target, null, f.db);
    expect(s.inspectorId).toBe(admin.actor.id);
    expect(s.runs.map((r) => r.id)).toEqual([a.task.runId]);
    expect(s.assignments[0]?.versionId).toBe(a.versionId);
    expect(s.quotaError).toBe(false);
    expect(
      await f.db`select id from allrice_memberships where organization_id=${a.target.organizationId} and user_id=${admin.actor.id}`,
    ).toHaveLength(0);
    expect(
      (
        await f.db`select role from allrice_memberships where user_id=${a.target.subjectId}`
      )[0]?.role,
    ).toBe('member');
  });
  it('projects run, operation, usage and artifact with real-issuer audit; no raw snapshot or common credentials', async () => {
    const result = await inspectTenantRun(admin, a.target, a.task.runId, f.db);
    expect(result.operations[0]).toMatchObject({
      id: a.operation,
      status: 'succeeded',
      approval: null,
    });
    expect(result.development).toBeNull();
    expect(result.artifacts[0]?.id).toBe(a.artifact.artifactId);
    expect(result.usage?.receiptCount).toBe(0);
    expect(result.usage?.totalTokens).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_TEST_SECRET|NEVER_EXPOSE_RAW_SNAPSHOT/,
    );
    const [audit] =
      await f.db`select actor_id,metadata from allrice_audit_events where action='tenant.run.inspected' and resource_id=${a.task.runId}`;
    expect(audit).toMatchObject({
      actor_id: admin.actor.id,
      metadata: { subjectId: a.target.subjectId, readOnly: true },
    });
    expect(
      (await f.db`select state from allrice_runs where id=${a.task.runId}`)[0]
        ?.state,
    ).toBe('running');
  });
  it('rejects foreign run, mismatched workspace/subject/device and member self-elevation', async () => {
    await expect(
      inspectTenantRun(admin, a.target, b.task.runId, f.db),
    ).rejects.toThrow('not_found');
    await expect(
      getTenantValidationSummary(
        admin,
        { ...a.target, workspaceId: b.target.workspaceId },
        null,
        f.db,
      ),
    ).rejects.toThrow();
    await expect(
      getTenantValidationSummary(
        admin,
        { ...a.target, subjectId: b.target.subjectId },
        null,
        f.db,
      ),
    ).rejects.toThrow();
    await expect(
      getTenantValidationSummary(admin, a.target, randomUUID(), f.db),
    ).rejects.toThrow('not_found');
    const session = await createSession(a.target.subjectId),
      member = (await authenticateSession(session.token))!;
    await expect(
      inspectTenantRun(member, a.target, a.task.runId, f.db),
    ).rejects.toThrow();
  });
  it('binds previews to the exact Run and audits the real viewer', async () => {
    await expect(
      inspectTenantRunArtifacts(
        admin,
        a.target,
        a.task.runId,
        b.artifact.artifactId,
        f.db,
      ),
    ).rejects.toThrow('artifact_not_found');
    const result = await inspectTenantRunArtifacts(
      admin,
      a.target,
      a.task.runId,
      a.artifact.artifactId,
      f.db,
    );
    expect(result.artifacts).toHaveLength(1);
    const [audit] =
      await f.db`select actor_id from allrice_audit_events where action='tenant.artifact.access_checked' and resource_id=${a.artifact.artifactId}`;
    expect(audit?.actor_id).toBe(admin.actor.id);
    await f.db`update allrice_chat_sessions set archived_at=now() where id=${a.task.chatSessionId}`;
    try {
      await expect(
        inspectTenantRunArtifacts(
          admin,
          a.target,
          a.task.runId,
          a.artifact.artifactId,
          f.db,
        ),
      ).rejects.toThrow('artifact_not_found');
    } finally {
      await f.db`update allrice_chat_sessions set archived_at=null where id=${a.task.chatSessionId}`;
    }
  });
  it('reports quota failure as unknown and rechecks authority after the failed read', async () => {
    const spy = vi
      .spyOn(quotas, 'getAdminTenantQuotas')
      .mockRejectedValue(new Error('synthetic quota outage'));
    try {
      const result = await getTenantValidationSummary(
        admin,
        a.target,
        null,
        f.db,
      );
      expect(result.quotaError).toBe(true);
      expect(result.quotas).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it('keeps long output bounded and identifies omitted chunks', async () => {
    await f.db`insert into allrice_runtime_operation_output(operation_id,sequence,stream,content) select ${a.operation},n,'stdout','x' from generate_series(1,80) n`;
    const result = await inspectTenantRun(admin, a.target, a.task.runId, f.db);
    expect(result.operations[0]?.outputTruncated).toBe(true);
    expect(result.operations[0]!.output.length).toBeLessThanOrEqual(16000);
  });
  it('projects expired approval without changing it or executing anything', async () => {
    const id = randomUUID();
    await f.db`insert into allrice_approval_requests(id,organization_id,workspace_id,run_id,actor_id,resource_type,resource_id,action,input_digest,requested_at,runtime_request,runtime_binding_digest,runtime_control_version,runtime_expires_at)
      values(${id},${a.target.organizationId},${a.target.workspaceId},${a.task.runId},${a.target.subjectId},'runtime_operation',${a.operation},'process.execute',${`sha256:${'a'.repeat(64)}`},now()-interval '2 hours','{}',${`sha256:${'b'.repeat(64)}`},1,now()-interval '1 hour')`;
    expect(
      (await inspectTenantRun(admin, a.target, a.task.runId, f.db))
        .operations[0]?.approval,
    ).toBe('expired');
    const [row] =
      await f.db`select status,runtime_consumed_at from allrice_approval_requests where id=${id}`;
    expect(row).toEqual({ status: 'pending', runtime_consumed_at: null });
  });
  it('rechecks live authority if revoked while the quota precheck was in flight', async () => {
    const session = await createSession(admin.actor.id),
      context = (await authenticateSession(session.token))!;
    const spy = vi
      .spyOn(quotas, 'getAdminTenantQuotas')
      .mockImplementation(async () => {
        await revokeSession(session.token);
        throw Error('Synthetic interrupted read');
      });
    try {
      await expect(
        getTenantValidationSummary(context, a.target, null, f.db),
      ).rejects.toThrow('authorization_denied');
    } finally {
      spy.mockRestore();
    }
  });
  it('rejects stale administrator sessions rather than trusting earlier context', async () => {
    await revokeSession(adminToken);
    await expect(
      inspectTenantRun(admin, a.target, a.task.runId, f.db),
    ).rejects.toThrow();
  });
});
