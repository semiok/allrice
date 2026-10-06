import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestContext } from '@allrice/contracts';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticatePlatformSession,
} from './identity.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import {
  enqueueRun,
  claimNextJob,
  startClaimedJob,
  completeJob,
  heartbeatJob,
  maintainQueue,
} from './execution/queue.ts';
import { updatePlatformRepositoryCredential } from './platform-repository-credentials.ts';
import {
  createPlatformRepositoryAction,
  getPlatformRepositoryPublication,
  cancelPlatformRepositoryAction,
  findPlatformRepositoryPublication,
} from './platform-repository-publications.ts';
import {
  repositoryRequestGate,
  withRepositoryAction,
  type RepositoryActionLease,
} from './platform-repository-publication-authority.ts';
import {
  freezeRepositoryPublicationMetadata,
  startRepositoryPublicationStep,
  confirmRepositoryPublicationStep,
  recordRepositoryCiObservation,
  finishRepositoryAction,
  readRepositoryAction,
} from './platform-repository-publication-ledger.ts';
import { technicalDigest } from './platform-technical-tasks.ts';
import {
  RepositoryPublicationSteps,
  repositoryRequiredChecks,
} from './platform-repository-publication-contracts.ts';
import { repositoryCommitIdentity } from './platform-repository-git.ts';
import {
  ensureDefaultEmployee,
  createChatSession,
} from './workspace/service.ts';
import { acceptedRepositoryFixture } from './platform-repository-publication.fixture.ts';
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite('private publication canonical queue and authority boundaries', () => {
  let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>,
    admin: RequestContext,
    other: RequestContext,
    execution: RequestContext,
    sourceId: string,
    revision = 1;
  const token = 'github_pat_' + 'SyntheticOnly'.repeat(7),
    tree = 'c'.repeat(40),
    author = {
      login: 'fixture',
      userId: 10,
      timestamp: '2026-10-06T01:00:00Z',
      message: 'fix: fixture',
    };
  const metadata = {
    tree,
    workflowBlob: 'd'.repeat(40),
    commit: repositoryCommitIdentity(tree, 'a'.repeat(40), author).sha,
    author,
  };
  beforeAll(async () => {
    f = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    vi.stubEnv(
      'ALLRICE_PLATFORM_ADMIN_EMAILS',
      'publication-admin@example.test,publication-other@example.test',
    );
    vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'a'.repeat(64));
    vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
    async function principal(email: string) {
      const a = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Internal',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control',
        email,
        displayName: 'Fixture',
        role: 'member',
      });
      const login = await createSession(a.user.id);
      return (await authenticatePlatformSession(login.token))!;
    }
    admin = await principal('publication-admin@example.test');
    other = await principal('publication-other@example.test');
    // Explicit nonzero microseconds expose the real PostgreSQL -> JS Date boundary.
    await f.db`update allrice_sessions set created_at=date_trunc('milliseconds',created_at)+interval '456 microseconds' where id=${admin.sessionId!}`;
    const { context: p } = await f.db.begin((tx) =>
      resolvePlatformPreviewContext(
        tx,
        { environment: 'platform', ownerId: admin.actor.id, workspaceId: null },
        admin.actor.id,
        true,
      ),
    );
    execution = {
      ...admin,
      organizationId: p.organization_id,
      workspaceId: p.workspace_id,
      memberships: [
        {
          id: p.membership_id,
          organizationId: p.organization_id,
          workspaceId: p.workspace_id,
          userId: admin.actor.id,
          role: p.role,
          active: true,
        },
      ],
    };
    const source = acceptedRepositoryFixture(
        admin.sessionId!,
        admin.authenticatedAt!,
      ),
      run = await enqueueRun(execution, {
        type: 'allrice.system.echo',
        workspaceId: execution.workspaceId,
        idempotencyKey: randomUUID(),
        input: {},
      });
    const [job] =
      await f.db`select id from allrice_jobs where run_id=${run.run.id}`;
    await f.db`update allrice_jobs set status='succeeded' where id=${job!.id}`;
    await ensureDefaultEmployee(execution, execution.workspaceId!);
    const session = await createChatSession(execution, {
      workspaceId: execution.workspaceId!,
      title: 'Synthetic accepted fixture',
    });
    sourceId = randomUUID();
    await f.db`insert into allrice_platform_repair_tasks(id,request_id,organization_id,workspace_id,owner_id,run_id,job_id,session_id,input_digest,frozen,candidate,report) values(${sourceId},${source.frozen.requestId},${execution.organizationId},${execution.workspaceId!},${admin.actor.id},${run.run.id},${job!.id},${session.id},${source.frozen.fingerprint},${f.db.json(source.frozen)},${f.db.json(source.candidate)},${f.db.json(source.report)})`;
    await updatePlatformRepositoryCredential(admin, {
      action: 'replace',
      requestId: randomUUID(),
      expectedRevision: 0,
      token,
    });
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (f) await f.close();
  });
  const publish = (requestId = randomUUID()) =>
    createPlatformRepositoryAction(admin, {
      action: 'publish',
      requestId,
      repairTaskId: sourceId,
      credentialRevision: revision,
    });
  async function start(
    p: Awaited<ReturnType<typeof publish>>,
    leaseMs = 30000,
  ): Promise<RepositoryActionLease> {
    const workerId = randomUUID(),
      j = await claimNextJob(workerId, leaseMs);
    expect(j!.id).toBe(p.actions[0]!.jobId);
    await startClaimedJob(workerId, j!.id, j!.lease!.token);
    return {
      workerId,
      jobId: j!.id,
      leaseToken: j!.lease!.token,
      attempt: j!.attempt,
    };
  }
  it('atomically deduplicates requests, isolates owners and refuses forged success without a receipt', async () => {
    const requestId = randomUUID(),
      a = await Promise.all([publish(requestId), publish(requestId)]);
    expect(a[0]!.id).toBe(a[1]!.id);
    expect(a[0]!.actions).toHaveLength(1);
    expect(
      (await findPlatformRepositoryPublication(admin, requestId))!.id,
    ).toBe(a[0]!.id);
    await expect(
      getPlatformRepositoryPublication(other, a[0]!.id),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      createPlatformRepositoryAction(other, {
        action: 'publish',
        requestId: randomUUID(),
        repairTaskId: sourceId,
        credentialRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(publish(requestId)).resolves.toMatchObject({ id: a[0]!.id });
    await expect(
      enqueueRun(execution, {
        type: 'allrice.platform.repository',
        workspaceId: execution.workspaceId,
        idempotencyKey: randomUUID(),
        input: {},
      }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    const lease = await start(a[0]!);
    await completeJob({ ...lease, result: { published: true } });
    expect(
      (await getPlatformRepositoryPublication(admin, a[0]!.id)).actions[0]!
        .errorCode,
    ).toBe('REPOSITORY_RECEIPT_REQUIRED');
  });
  it('persists one START, serializes credential removal and stops the revoked action', async () => {
    const p = await publish(),
      lease = await start(p);
    await freezeRepositoryPublicationMetadata(lease, metadata);
    expect(await startRepositoryPublicationStep(lease, 'blob')).toBe(true);
    expect(await startRepositoryPublicationStep(lease, 'blob')).toBe(false);
    await expect(
      confirmRepositoryPublicationStep(lease, 'blob', 'e'.repeat(40)),
    ).rejects.toMatchObject({ code: 'conflict' });
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((r) => (entered = r)),
      blocked = new Promise<void>((r) => (release = r));
    const hold = withRepositoryAction(lease, async () => {
      entered();
      await blocked;
    });
    await inside;
    let rotated = false;
    const removal = updatePlatformRepositoryCredential(admin, {
      action: 'remove',
      requestId: randomUUID(),
      expectedRevision: revision,
    }).then(() => {
      rotated = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(rotated).toBe(false);
    release();
    await hold;
    await removal;
    revision++;
    await expect(repositoryRequestGate(lease)).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await heartbeatJob(lease.workerId, lease.jobId, lease.leaseToken, 30000);
    expect(
      (await getPlatformRepositoryPublication(admin, p.id)).actions[0]!.status,
    ).toBe('failed');
    await updatePlatformRepositoryCredential(admin, {
      action: 'replace',
      requestId: randomUUID(),
      expectedRevision: revision,
      token,
    });
    revision++;
  });
  it('requires a fresh inspect observation and rejects incomplete green CI', async () => {
    const previous = await publish();
    await cancelPlatformRepositoryAction(
      admin,
      previous.id,
      previous.actions[0]!.id,
    );
    await maintainQueue();
    const p = await createPlatformRepositoryAction(admin, {
        action: 'inspect',
        publicationId: previous.id,
        requestId: randomUUID(),
        credentialRevision: revision,
      }),
      lease = await start(p);
    await expect(finishRepositoryAction(lease)).rejects.toMatchObject({
      code: 'conflict',
    });
    const ci = {
      state: 'unknown',
      observedAt: new Date().toISOString(),
      workflowRunId: null,
      runAttempt: null,
      headSha: metadata.commit,
      checkoutSha: null,
      checkoutTree: null,
      materialDigest: null,
      checks: [],
    };
    await expect(
      recordRepositoryCiObservation(lease, {
        ...ci,
        state: 'passed',
        checkoutTree: tree,
        materialDigest: 'sha256:' + 'a'.repeat(64),
      }),
    ).rejects.toBeDefined();
    await recordRepositoryCiObservation(lease, ci);
    await finishRepositoryAction(lease);
    await completeJob({ ...lease, result: {} });
    expect(
      (await getPlatformRepositoryPublication(admin, p.id)).actions[0]!.status,
    ).toBe('succeeded');
    expect((await getPlatformRepositoryPublication(admin, p.id)).ci.state).toBe(
      'unknown',
    );
  });
  it('cancellation fences late confirmations and cannot be revived by a Worker result', async () => {
    const p = await publish(),
      lease = await start(p);
    await cancelPlatformRepositoryAction(admin, p.id, p.actions[0]!.id);
    await expect(
      confirmRepositoryPublicationStep(lease, 'blob', 'e'.repeat(40)),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await completeJob({ ...lease, result: { published: true } });
    expect(
      (await getPlatformRepositoryPublication(admin, p.id)).actions[0]!.status,
    ).toBe('canceled');
  });
  it('protects current membership through a gate transaction and denies subsequent revocation', async () => {
    const p = await publish(),
      lease = await start(p),
      member = execution.memberships[0]!.id;
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((r) => (entered = r)),
      blocked = new Promise<void>((r) => (release = r));
    const held = withRepositoryAction(lease, async () => {
      entered();
      await blocked;
    });
    await inside;
    let revoked = false;
    const revoke =
      f.db`update allrice_memberships set active=false where id=${member}`.then(
        () => {
          revoked = true;
        },
      );
    await new Promise((r) => setTimeout(r, 50));
    expect(revoked).toBe(false);
    release();
    await held;
    await revoke;
    await expect(repositoryRequestGate(lease)).rejects.toBeDefined();
    await heartbeatJob(lease.workerId, lease.jobId, lease.leaseToken, 30000);
    expect(
      (await getPlatformRepositoryPublication(admin, p.id)).actions[0]!.status,
    ).toBe('failed');
    await f.db`update allrice_memberships set active=true where id=${member}`;
  });
  it('rechecks a lease after waiting for the credential lock', async () => {
    const p = await publish(),
      lease = await start(p, 1000);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((r) => (entered = r)),
      blocked = new Promise<void>((r) => (release = r));
    const held = f.db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`platform-repository-credential:${admin.actor.id}:1323769790`}))`;
      entered();
      await blocked;
    });
    await inside;
    const waiting = repositoryRequestGate(lease).then(
      () => 'accepted',
      (error) => error.code,
    );
    const [j] =
      await f.db`select greatest(0,extract(epoch from(lease_expires_at-clock_timestamp()))*1000)::int remaining from allrice_jobs where id=${lease.jobId}`;
    await new Promise((r) => setTimeout(r, Number(j!.remaining) + 60));
    release();
    await held;
    expect(await waiting).toBe('lease_lost');
    await maintainQueue();
    expect(
      (await getPlatformRepositoryPublication(admin, p.id)).actions[0]!.status,
    ).toBe('failed');
  });
  it('stores four distinct original CI proofs and refuses copying a single receipt four times', async () => {
    const p = await publish(),
      lease = await start(p);
    await freezeRepositoryPublicationMetadata(lease, metadata);
    const row = await readRepositoryAction(lease),
      source = row.source;
    const remote = {
      repositoryId: 1323769790,
      repository: 'semiok/allrice',
      branch: 'allrice/repairs/' + p.id,
      number: 312,
      url: 'https://github.com/semiok/allrice/pull/312',
      headSha: metadata.commit,
      tree,
      baseSha: source.baseSha,
    };
    for (const step of RepositoryPublicationSteps) {
      await startRepositoryPublicationStep(lease, step);
      await confirmRepositoryPublicationStep(
        lease,
        step,
        step === 'blob'
          ? source.afterBlob
          : step === 'tree'
            ? tree
            : step === 'pull'
              ? remote
              : metadata.commit,
      );
    }
    const digest = source.candidateChecksum;
    const evidence = repositoryRequiredChecks.map((job, i) => ({
      artifactId: 400 + i,
      archiveDigest: digest,
      receipt: {
        version: 1,
        scope: 'allrice.repository-ci.v1',
        repositoryId: 1323769790,
        repository: 'semiok/allrice',
        workflowPath: '.github/workflows/ci.yml',
        workflowBlob: metadata.workflowBlob,
        workflowRunId: 100,
        runAttempt: 1,
        job,
        event: 'pull_request',
        pullRequest: 312,
        headSha: metadata.commit,
        baseSha: source.baseSha,
        checkoutSha: 'f'.repeat(40),
        checkoutTree: tree,
        materialDigest: source.candidateMaterialDigest,
        rootLockChecksum: source.rootLockChecksum,
        dependencyConfigurationDigest: source.dependencyConfigurationDigest,
        nodeVersion: 'v22.23.2',
        runnerOs: 'Linux',
        runnerArch: 'X64',
        build:
          job === 'validate'
            ? {
                rootScript: 'pnpm -r --if-present run build',
                packages: [
                  {
                    name: '@allrice/worker',
                    path: 'apps/worker',
                    scriptChecksum: digest,
                    outputDigest: digest,
                    fileCount: 1,
                    sizeBytes: 1,
                  },
                ],
              }
            : null,
      },
    }));
    const ci = {
      state: 'passed',
      observedAt: new Date().toISOString(),
      workflowRunId: 100,
      runAttempt: 1,
      headSha: metadata.commit,
      checkoutSha: 'f'.repeat(40),
      checkoutTree: tree,
      materialDigest: source.candidateMaterialDigest,
      checks: repositoryRequiredChecks.map((name, i) => ({
        name,
        id: 200 + i,
        conclusion: 'success',
      })),
      receipts: evidence.map((e) => ({
        name: e.receipt.job,
        artifactId: e.artifactId,
        archiveDigest: e.archiveDigest,
        receiptDigest: technicalDigest(e.receipt),
      })),
    };
    await recordRepositoryCiObservation(lease, ci, evidence);
    await expect(
      recordRepositoryCiObservation(lease, ci, Array(4).fill(evidence[0])),
    ).rejects.toMatchObject({ code: 'conflict' });
    await finishRepositoryAction(lease);
    await completeJob({ ...lease, result: {} });
    expect((await getPlatformRepositoryPublication(admin, p.id)).ci.state).toBe(
      'passed',
    );
  });
});
