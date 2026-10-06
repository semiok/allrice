/** Real isolated PostgreSQL/native protocol/storage, with synthetic CI records.
 * No provider, GitHub, physical command, deployment or paid model is called. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  type RequestContext,
  type DevelopmentArtifactRef,
} from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  createAssistantFixtureDatabase,
  assistantFixtureStorage,
} from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createExperienceFixture } from '../../../../packages/database/src/experience.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticatePlatformSession,
} from '../../../../packages/database/src/identity.ts';
import { buildEmployeeRuntimePackage } from '../../../../packages/database/src/platform-employees/runtime-package.ts';
import { ensureQualityEmployee } from '../../../../packages/database/src/platform-quality.ts';
import { resolvePlatformPreviewContext } from '../../../../packages/database/src/platform-employees/preview-context.ts';
import { createChatSession } from '../../../../packages/database/src/workspace/service.ts';
import { repositoryReviewFixture } from '../../../../packages/database/src/platform-repository-review.fixture.ts';
import { freezeRepositoryPublicationSource } from '../../../../packages/database/src/platform-repository-publication-source.ts';
import { repositoryFactsDigest } from '../../../../packages/database/src/platform-repository-publication-ledger.ts';
import { technicalDigest } from '../../../../packages/database/src/platform-technical-tasks.ts';
import { updatePlatformRepositoryCredential } from '../../../../packages/database/src/platform-repository-credentials.ts';
import {
  createPlatformRepositoryReview,
  getPlatformRepositoryReview,
  getPlatformRepositoryReviewPanel,
  getPlatformRepositoryReviewArtifact,
  cancelPlatformRepositoryReview,
  repositoryReviewRequestGate,
  recordRepositoryReviewRemote,
} from '../../../../packages/database/src/platform-repository-reviews.ts';
import {
  repositoryReviewConfiguration,
  repositoryReviewTools,
  type RepositoryReviewMaterial,
} from '../../../../packages/database/src/platform-repository-review-contracts.ts';
import {
  enqueueRun,
  claimNextJob,
  startClaimedJob,
  completeJob,
} from '../../../../packages/database/src/execution/queue.ts';
import { acquireConversationRuntime } from '../../../../packages/database/src/conversation/conversation-runtime.ts';
import { assertAssistantAuthority } from '../../../../packages/database/src/assistant-authority.ts';
import { productionAssistantController } from '../../src/harness/dsh/assistant-controller.js';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
suite(
  'platform repository review native workflow and current authority',
  () => {
    let f: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
    const emails = new Set<string>();
    beforeAll(async () => {
      f = await createAssistantFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      vi.stubEnv('ALLRICE_ENV', 'development');
      vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'a'.repeat(64));
      vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
      for (const flag of ['ASSISTANTS', 'WORKBENCH', 'RUNTIME_POLICY'])
        vi.stubEnv(`ALLRICE_${flag}_ENABLED`, '1');
      await createExperienceFixture(f.db);
      await f.db`update allrice_model_connections set status='ready' where id='52000000-0000-4000-8000-000000000001'`;
      await f.db`update allrice_model_providers set enabled=true where provider_key='codex'`;
      const [revision] =
        await f.db`select r.* from allrice_platform_employee_revisions r join allrice_platform_employees e on e.current_published_revision_id=r.id where e.employee_key='rice'`;
      const toolNames = [
        'workspace.project',
        'browser.workspace',
        ...repositoryReviewTools,
      ];
      const definition = PlatformEmployeeDefinitionSchema.parse({
        ...revision!.definition,
        capabilities: {
          ...revision!.definition.capabilities,
          nativeSkillIds: [],
          explicitToolNames: toolNames,
          toolNames,
        },
      });
      const runtimePackage = buildEmployeeRuntimePackage({
        revision: revision!.revision,
        definition,
        skills: [],
      });
      const profile = PlatformEmployeeRuntimeProfileSchema.parse({
        ...revision!.runtime_profile,
        toolNames,
        nativeSkillIds: [],
        nativeSkillChecksums: [],
        runtimePackage,
      });
      await f.db`update allrice_platform_employee_revisions set definition=${f.db.json(definition)},runtime_profile=${f.db.json(profile)},checksum=${runtimePackage.checksum},status='published',published_at=now() where id=${revision!.id}`;
      await f.db`update allrice_platform_employees set status='published' where id=${revision!.employee_id}`;
    }, 120000);
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await f?.close();
    });

    async function setup() {
      const email = `review-${randomUUID()}@example.test`;
      emails.add(email);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', [...emails].join(','));
      const principal = await ensureBootstrapPortalPrincipal({
        organizationSlug: 'allrice-platform',
        organizationName: 'Internal',
        workspaceSlug: 'control-plane',
        workspaceName: 'Control',
        email,
        displayName: 'Review fixture',
        role: 'member',
      });
      const login = await createSession(principal.user.id),
        admin = (await authenticatePlatformSession(login.token))!;
      const employee = await ensureQualityEmployee(admin);
      const { context: p } = await f.db.begin((tx) =>
        resolvePlatformPreviewContext(
          tx,
          {
            environment: 'platform',
            ownerId: admin.actor.id,
            workspaceId: null,
          },
          admin.actor.id,
        ),
      );
      const internal: RequestContext = {
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
      const control = {
        version: 1,
        enabled: true,
        mode: 'execute',
        rules: [{ action: 'assistant.delegate', effect: 'allow' }],
      };
      await f.db`insert into allrice_runtime_policy_controls(organization_id,workspace_id,version,controls) values(${internal.organizationId},${internal.workspaceId!},1,${f.db.json(control)}) on conflict(organization_id,workspace_id) do update set controls=excluded.controls,version=excluded.version`;
      const data = repositoryReviewFixture(
        admin.sessionId!,
        admin.authenticatedAt!,
      );
      data.publication.owner_id = admin.actor.id;
      data.publication.organization_id = internal.organizationId;
      data.publication.workspace_id = internal.workspaceId!;
      async function sourceRun() {
        const run = await enqueueRun(internal, {
          type: 'allrice.system.echo',
          workspaceId: internal.workspaceId,
          idempotencyKey: randomUUID(),
          input: {},
        });
        const [job] =
          await f.db`update allrice_jobs set status='succeeded' where run_id=${run.run.id} returning id`;
        await f.db`update allrice_runs set state='succeeded' where id=${run.run.id}`;
        return { runId: run.run.id, jobId: job!.id as string };
      }
      const source = await sourceRun(),
        inspection = await sourceRun(),
        session = await createChatSession(internal, {
          employeeAssignmentId: employee.assignmentId,
          title: 'Synthetic source evidence',
          workspaceId: internal.workspaceId,
        });
      data.repair.run_id = source.runId;
      data.repair.job_id = source.jobId;
      data.publication.source = freezeRepositoryPublicationSource(
        data.repair,
        data.repair.frozen.baseline.sourceSha,
      );
      data.publication.source_digest = technicalDigest(data.publication.source);
      data.inspection.receipt.sourceDigest = data.publication.source_digest;
      await f.db`insert into allrice_platform_repair_tasks(id,request_id,organization_id,workspace_id,owner_id,run_id,job_id,session_id,input_digest,frozen,candidate,report)
      values(${data.repair.id},${data.repair.frozen.requestId},${internal.organizationId},${internal.workspaceId!},${admin.actor.id},${source.runId},${source.jobId},${session.id},${data.repair.frozen.fingerprint},${f.db.json(data.repair.frozen)},${f.db.json(data.repair.candidate)},${f.db.json(data.repair.report)})`;
      const pub = data.publication;
      await f.db`insert into allrice_platform_repository_publications(id,owner_id,organization_id,workspace_id,source_task_id,base_sha,after_checksum,source,source_digest,metadata,steps,remote,ci,ci_evidence)
      values(${pub.id},${admin.actor.id},${internal.organizationId},${internal.workspaceId!},${data.repair.id},${pub.source.baseSha},${pub.source.afterChecksum},${f.db.json(pub.source)},${pub.source_digest},${f.db.json(pub.metadata)},${f.db.json(pub.steps)},${f.db.json(pub.remote)},${f.db.json(pub.ci)},${f.db.json(pub.ci_evidence)})`;
      data.inspection.receipt.factsDigest = repositoryFactsDigest(pub);
      const request = {
        action: 'inspect',
        requestId: randomUUID(),
        publicationId: pub.id,
        credentialRevision: 1,
      };
      await f.db`insert into allrice_platform_repository_actions(id,publication_id,owner_id,request_id,request,input_digest,login_session_id,login_authenticated_at,credential_revision,mode,timeout_ms,run_id,job_id,receipt)
      values(${randomUUID()},${pub.id},${admin.actor.id},${request.requestId},${f.db.json(request)},${technicalDigest(request)},${admin.sessionId!},${admin.authenticatedAt!},1,'inspect',30000,${inspection.runId},${inspection.jobId},${f.db.json(data.inspection.receipt)})`;
      await updatePlatformRepositoryCredential(admin, {
        action: 'replace',
        requestId: randomUUID(),
        expectedRevision: 0,
        token: 'github_pat_' + 'SyntheticOnly'.repeat(7),
      });
      const panel = await getPlatformRepositoryReviewPanel(admin, pub.id, 1);
      expect(panel.canStart).toBe(true);
      const create = (requestId: string = randomUUID()) =>
        createPlatformRepositoryReview(admin, {
          requestId,
          publicationId: pub.id,
          expectedSubjectDigest: panel.subjectDigest,
          credentialRevision: 1,
        });
      return { admin, internal, data, create, panel };
    }
    async function start(s: Awaited<ReturnType<typeof setup>>) {
      const review = await s.create(),
        workerId = randomUUID(),
        job = await claimNextJob(workerId, 300000);
      expect(job!.id).toBe(review.jobId);
      const lease = {
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        attempt: job!.attempt,
      };
      const execution = (await startClaimedJob(
        workerId,
        job!.id,
        lease.leaseToken,
      ))!;
      expect(execution).not.toBeNull();
      await recordRepositoryReviewRemote(
        lease,
        'preflight',
        s.data.publication.ci,
        s.data.publication.ci_evidence,
      );
      const runtime = await acquireConversationRuntime({
        organizationId: s.internal.organizationId,
        workspaceId: s.internal.workspaceId!,
        sessionId: review.sessionId,
        ownerId: s.admin.actor.id,
        runId: review.runId,
        workerId,
        configChecksum: technicalDigest('isolated review'),
        compactThresholdTokens: 100000,
      });
      const nativeSessionId = randomUUID();
      const controller = productionAssistantController({
        repositoryReview: true,
        nativeSkills: [],
        configuration: repositoryReviewConfiguration,
        context: execution.context,
        worker: lease,
        runLimits: {},
        tools: repositoryReviewTools.map((name) => ({ name })),
        authorize: assertAssistantAuthority,
        database: f.db,
        storage: assistantFixtureStorage(f.db),
      })!;
      const bridge = await controller.bind(nativeSessionId, runtime.generation);
      const call = (
        method: string,
        args: unknown,
        nativeId: string = nativeSessionId,
        callId: string = randomUUID(),
      ) =>
        bridge.handle(method, {
          nativeSessionId: nativeId,
          callId,
          arguments: args,
        });
      const development = async (
        args: unknown,
        nativeId: string = nativeSessionId,
      ) => {
        const result = await call(
          'development',
          { command: JSON.stringify(args) },
          nativeId,
        );
        expect(result).toHaveProperty('development');
        return result.development;
      };
      if (!bridge.finish) throw Error('production finalizer missing');
      return {
        ...s,
        review,
        lease,
        execution,
        bridge,
        call,
        development,
        finish: bridge.finish,
        nativeSessionId,
        generation: runtime.generation,
      };
    }
    async function opinion(
      s: Awaited<ReturnType<typeof start>>,
      verdict: 'accept' | 'revise' = 'accept',
    ) {
      const seed = (await s.development({ action: 'inspect' })) as {
        candidate: DevelopmentArtifactRef;
        evidence: unknown;
        material: RepositoryReviewMaterial;
      };
      const child = (await s.call('delegate', {
        label: 'independent reviewer',
        text: 'Review exact saved patch',
        tools: ['assistant.development', 'assistant.report'],
        development: JSON.stringify({
          expectedHead: seed.candidate,
          role: 'review',
        }),
      })) as {
        instance: { runId: string };
        nativeSessionId: string;
        inputId: string;
        text: string;
      };
      expect(seed.material.authorRunIds).not.toContain(child.instance.runId);
      expect(child.text).toContain(
        'evidence=[{id:reviewResult.artifact.artifactId',
      );
      expect(child.text).not.toContain('use evidence=[]');
      await s.bridge.handle('checkpoint', {
        nativeSessionId: child.nativeSessionId,
        inputId: child.inputId,
        nativeMessageId: randomUUID(),
        durableSeq: 1,
        adoptedSeq: 1,
      });
      await s.development(
        { action: 'inspect', candidate: seed.candidate },
        child.nativeSessionId,
      );
      const review = (await s.development(
        {
          action: 'review',
          candidate: seed.candidate,
          evidence: seed.evidence,
          verdict,
          summary: 'Synthetic test opinion, not real model review',
        },
        child.nativeSessionId,
      )) as { id: string; artifact: DevelopmentArtifactRef };
      // Settle the launch's non-dispatched reservation through the existing ledger;
      // this synthetic protocol test does not fabricate provider usage.
      const [hold] =
        await f.db`select call_id from allrice_assistant_usage where run_id=${child.instance.runId} and metric='model_calls' and settled_amount is null`;
      const { createAssistantRuntime } =
        await import('../../../../packages/database/src/assistant-runtime.ts');
      const actualRuntime = createAssistantRuntime({
        database: f.db,
        authorize: assertAssistantAuthority,
      });
      const [root] =
        await f.db`select task from allrice_runtime_roots where root_run_id=${s.review.runId}`;
      await actualRuntime.settleUsage({
        scope: root!.task.scope,
        rootRunId: s.review.runId,
        worker: { ...s.lease, generation: s.generation },
        runId: child.instance.runId,
        callId: hold!.call_id,
        amounts: { model_calls: 0 },
      });
      const result = (await s.call(
        'report',
        {
          status: 'completed',
          summary: 'Saved exact independent opinion',
          evidence: [
            { id: review.artifact.artifactId, digest: review.artifact.digest },
          ],
          incomplete: [],
        },
        child.nativeSessionId,
      )) as { deliveryId: string };
      await s.bridge.handle('adopt-result', {
        nativeSessionId: s.nativeSessionId,
        deliveryId: result.deliveryId,
        nativeMessageId: randomUUID(),
        adoptedSeq: 2,
      });
      return { seed, child, review };
    }

    it('completes native inspect → fresh child → saved opinion → adopted report → delivery → canonical job and private download', async () => {
      const s = await start(await setup()),
        o = await opinion(s);
      await expect(
        s.development({
          action: 'review',
          candidate: o.seed.candidate,
          evidence: o.seed.evidence,
          verdict: 'accept',
          summary: 'author opinion',
        }),
      ).rejects.toThrow();
      const delivered = (await s.development({
        action: 'deliver',
        candidate: o.seed.candidate,
        reviewId: o.review.id,
      })) as { artifact: DevelopmentArtifactRef };
      expect((await s.finish()).status).toBe('completed');
      await recordRepositoryReviewRemote(
        s.lease,
        'postflight',
        s.data.publication.ci,
        s.data.publication.ci_evidence,
      );
      await completeJob({
        ...s.lease,
        result: { syntheticProtocolOnly: true },
      });
      const detail = await getPlatformRepositoryReview(s.admin, s.review.id);
      expect(detail.status).toBe('succeeded');
      expect(detail.reviewerRunId).toBe(o.child.instance.runId);
      expect(detail.deliveryArtifactId).toBe(delivered.artifact.artifactId);
      expect(
        (
          await getPlatformRepositoryReviewPanel(
            s.admin,
            s.data.publication.id,
            1,
          )
        ).readiness.state,
      ).toBe('accepted');
      expect(
        (
          await getPlatformRepositoryReviewArtifact(
            s.admin,
            s.review.id,
            detail.reviewArtifactId!,
          )
        ).object.immutable,
      ).toBe(true);
      const other = await setup();
      await expect(
        getPlatformRepositoryReview(other.admin, s.review.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        getPlatformRepositoryReviewArtifact(
          other.admin,
          s.review.id,
          detail.reviewArtifactId!,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (
          await f.db`select root_run_id from allrice_development_heads where root_run_id=${s.review.runId}`
        ).length,
      ).toBe(0);
    }, 30000);
    it('cancellation of a completed reviewer invalidates delivery and final completion', async () => {
      const s = await start(await setup()),
        o = await opinion(s);
      await s.development({
        action: 'deliver',
        candidate: o.seed.candidate,
        reviewId: o.review.id,
      });
      await s.call('stop', { childRunId: o.child.instance.runId });
      expect((await s.finish()).status).toBe('partial');
      await expect(
        recordRepositoryReviewRemote(
          s.lease,
          'postflight',
          s.data.publication.ci,
          s.data.publication.ci_evidence,
        ),
      ).rejects.toThrow();
      await completeJob({ ...s.lease, result: { prose: 'accepted' } });
      expect(
        (await getPlatformRepositoryReview(s.admin, s.review.id)).status,
      ).toBe('failed');
    }, 30000);
    it('retains revise for identical code and cannot replace the reviewer or opinion', async () => {
      const s = await start(await setup()),
        o = await opinion(s, 'revise');
      await expect(
        s.development({
          action: 'deliver',
          candidate: o.seed.candidate,
          reviewId: o.review.id,
        }),
      ).rejects.toThrow();
      await expect(
        s.development(
          {
            action: 'review',
            candidate: o.seed.candidate,
            evidence: o.seed.evidence,
            verdict: 'accept',
            summary: 'replacement',
          },
          o.child.nativeSessionId,
        ),
      ).rejects.toThrow();
      expect((await s.finish()).status).toBe('completed');
      await recordRepositoryReviewRemote(
        s.lease,
        'postflight',
        s.data.publication.ci,
        s.data.publication.ci_evidence,
      );
      await completeJob({ ...s.lease, result: {} });
      expect(
        (
          await getPlatformRepositoryReviewPanel(
            s.admin,
            s.data.publication.id,
            1,
          )
        ).readiness.state,
      ).toBe('revise');
      await expect(s.create()).rejects.toMatchObject({ code: 'conflict' });
    }, 30000);
    it('deduplicates concurrent identical creates and rejects changed request content', async () => {
      const s = await setup(),
        requestId = randomUUID();
      const values = await Promise.all([
        s.create(requestId),
        s.create(requestId),
      ]);
      expect(values[0]!.runId).toBe(values[1]!.runId);
      expect(
        (
          await f.db`select id from allrice_platform_repository_review_subjects where owner_id=${s.admin.actor.id} and request_id=${requestId}`
        ).length,
      ).toBe(1);
      await expect(
        createPlatformRepositoryReview(s.admin, {
          requestId,
          publicationId: s.data.publication.id,
          expectedSubjectDigest: technicalDigest('different'),
          credentialRevision: 1,
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      await cancelPlatformRepositoryReview(s.admin, values[0]!.id);
    }, 30000);
    it('returns the committed same request when the initial empty lookup precedes another create', async () => {
      const s = await setup(),
        requestId = randomUUID();
      let readEmpty!: () => void, resume!: () => void;
      const emptyRead = new Promise<void>((resolve) => {
          readEmpty = resolve;
        }),
        resumed = new Promise<void>((resolve) => {
          resume = resolve;
        });
      let intercept = true;
      const db = new Proxy(f.db, {
        apply(target, thisArg, args: unknown[]) {
          const query = Reflect.apply(target, thisArg, args) as Promise<
            readonly Record<string, unknown>[]
          >;
          const text = Array.isArray(args[0]) ? args[0].join('') : '';
          if (
            intercept &&
            text.includes(
              'select id,input_digest from allrice_platform_repository_review_subjects',
            )
          ) {
            intercept = false;
            return query.then(async (rows) => {
              expect(rows).toHaveLength(0);
              readEmpty();
              await resumed;
              return rows;
            });
          }
          return query;
        },
      });
      vi.mocked(client.getDatabase).mockReturnValue(db);
      const paused = s.create(requestId);
      try {
        await emptyRead;
        const committed = await s.create(requestId);
        resume();
        const recovered = await paused;
        expect([
          recovered.id,
          recovered.runId,
          recovered.jobId,
          recovered.sessionId,
        ]).toEqual([
          committed.id,
          committed.runId,
          committed.jobId,
          committed.sessionId,
        ]);
        const rows =
          await f.db`select s.id,s.run_id,s.job_id from allrice_platform_repository_review_subjects s join allrice_jobs j on j.id=s.job_id and j.run_id=s.run_id where s.owner_id=${s.admin.actor.id} and s.request_id=${requestId}`;
        expect(rows).toHaveLength(1);
        await cancelPlatformRepositoryReview(s.admin, recovered.id);
      } finally {
        resume();
        vi.mocked(client.getDatabase).mockReturnValue(f.db);
        await paused.catch(() => undefined);
      }
    }, 30000);
    it('rechecks lease after waiting for credential locks and bounds every request by the lease', async () => {
      const s = await start(await setup());
      expect(
        (await repositoryReviewRequestGate(s.lease)).remainingMs,
      ).toBeGreaterThan(0);
      await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '150 milliseconds' where id=${s.review.jobId}`;
      let locked!: () => void, release!: () => void;
      const acquired = new Promise<void>((r) => {
          locked = r;
        }),
        unblock = new Promise<void>((r) => {
          release = r;
        });
      const holder = f.db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`platform-repository-credential:${s.admin.actor.id}:1323769790`}))`;
        locked();
        await unblock;
      });
      await acquired;
      const gated = repositoryReviewRequestGate(s.lease);
      await new Promise((r) => setTimeout(r, 220));
      release();
      await holder;
      await expect(gated).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      await expect(
        recordRepositoryReviewRemote(
          s.lease,
          'postflight',
          s.data.publication.ci,
          s.data.publication.ci_evidence,
        ),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }, 30000);
    it('fails closed when the login or persisted source/CI is revoked, retaining history', async () => {
      const s = await start(await setup());
      await f.db`update allrice_sessions set revoked_at=clock_timestamp() where id=${s.admin.sessionId!}`;
      await expect(s.development({ action: 'inspect' })).rejects.toThrow();
      await expect(repositoryReviewRequestGate(s.lease)).rejects.toMatchObject({
        code: 'authorization_denied',
      });
      expect(
        (await getPlatformRepositoryReview(s.admin, s.review.id)).status,
      ).toBe('running');
    }, 30000);
  },
);
