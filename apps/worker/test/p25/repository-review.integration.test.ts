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

import { runtimeLedgerInputDigest } from '../../../../packages/database/src/runtime-ledger/ledger.ts';
import { lockRepositoryReviewContent } from '../../../../packages/database/src/platform-repository-review-facts.ts';
import { repositoryReviewCompletionAllowed } from '../../../../packages/database/src/platform-repository-review-authority.ts';
import type { JobRow } from '../../../../packages/database/src/queue/row-mappers.ts';
import { repositoryMergeRequestGate } from '../../../../packages/database/src/platform-repository-merge-authority.ts';
import { readCompletedRepositoryReview } from '../../../../packages/database/src/platform-repository-completed-review.ts';
import {
  createPlatformRepositoryMerge,
  getPlatformRepositoryMerge,
  getPlatformRepositoryMergePanel,
  startRepositoryMergeEffect,
  findPlatformRepositoryMerge,
} from '../../../../packages/database/src/platform-repository-merges.ts';
import { mergeRepositoryCandidate } from '../../src/repository-repair/merger.js';
import { FixedRepositoryGithub } from '../../src/repository-repair/github.js';
import { failJob } from '../../../../packages/database/src/execution/queue.ts';
import { repositoryRequiredChecks } from '../../../../packages/database/src/platform-repository-publication-contracts.ts';
import { platformRepository } from '../../../../packages/database/src/platform-repository-credential-contracts.ts';
// These synthetic legacy merge protocol cases preserve pre-existing intent and
// proof algorithms for historical reconciliation. The product action guard is
// intentionally disabled ONLY in this test module; current production denial is
// independently exercised without mocks in platform-maintenance.integration
// and maintenance-write-boundary.test. No provider or remote write is executed.
vi.mock(
  '../../../../packages/database/src/platform-maintenance-actions.ts',
  () => ({ assertMaintenanceWriteAction: () => {} }),
);
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
    async function start(
      s: Awaited<ReturnType<typeof setup>>,
      existing?: Awaited<ReturnType<typeof createPlatformRepositoryReview>>,
    ) {
      const review = existing ?? (await s.create()),
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

    async function completedReview() {
      return completeReview(await start(await setup()));
    }
    async function completeReview(s: Awaited<ReturnType<typeof start>>) {
      const o = await opinion(s);
      await s.development({
        action: 'deliver',
        candidate: o.seed.candidate,
        reviewId: o.review.id,
      });
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
      await f.db`update allrice_jobs set timeout_at=created_at+interval '1 millisecond' where id=${s.lease.jobId}`;
      await f.db`update allrice_runtime_roots set deadline_at=clock_timestamp()-interval '1 millisecond' where root_run_id=${s.review.runId}`;
      return { ...s, o };
    }
    async function rerunReview(s: Awaited<ReturnType<typeof completedReview>>) {
      const p = s.data.publication;
      const evidence = structuredClone(p.ci_evidence);
      for (const e of evidence) {
        e.receipt.runAttempt = 2;
        e.artifactId += 10;
      }
      const ci = {
        ...p.ci,
        runAttempt: 2,
        receipts: evidence.map((e) => ({
          name: e.receipt.job,
          artifactId: e.artifactId,
          archiveDigest: e.archiveDigest,
          receiptDigest: technicalDigest(e.receipt),
        })),
      };
      await f.db`update allrice_platform_repository_publications set ci=${f.db.json(ci)},ci_evidence=${f.db.json(evidence)} where id=${p.id}`;
      const run = await enqueueRun(s.internal, {
        type: 'allrice.system.echo',
        workspaceId: s.internal.workspaceId,
        idempotencyKey: randomUUID(),
        input: {},
      });
      const [job] =
        await f.db`update allrice_jobs set status='succeeded' where run_id=${run.run.id} returning id`;
      await f.db`update allrice_runs set state='succeeded' where id=${run.run.id}`;
      const request = {
        action: 'inspect',
        requestId: randomUUID(),
        publicationId: p.id,
        credentialRevision: 1,
      };
      const receipt = {
        ...s.data.inspection.receipt,
        factsDigest: repositoryFactsDigest({ ...p, ci, ci_evidence: evidence }),
      };
      await f.db`insert into allrice_platform_repository_actions(id,publication_id,owner_id,request_id,request,input_digest,login_session_id,login_authenticated_at,credential_revision,mode,timeout_ms,run_id,job_id,receipt)
        values(${randomUUID()},${p.id},${s.admin.actor.id},${request.requestId},${f.db.json(request)},${technicalDigest(request)},${s.admin.sessionId!},${s.admin.authenticatedAt!},1,'inspect',30000,${run.run.id},${job!.id},${f.db.json(receipt)})`;
      const panel = await getPlatformRepositoryReviewPanel(s.admin, p.id, 1);
      const review = await createPlatformRepositoryReview(s.admin, {
        requestId: randomUUID(),
        publicationId: p.id,
        expectedSubjectDigest: panel.subjectDigest,
        credentialRevision: 1,
      });
      return start(
        {
          ...s,
          data: { ...s.data, publication: { ...p, ci, ci_evidence: evidence } },
        },
        review,
      );
    }
    async function claimMerge(runId: string) {
      const [expected] =
        await f.db`select id from allrice_jobs where run_id=${runId}`;
      const workerId = randomUUID(),
        job = await claimNextJob(workerId, 300000);
      expect(job?.id).toBe(expected!.id);
      const lease = {
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        attempt: job!.attempt,
      };
      await startClaimedJob(workerId, job!.id, lease.leaseToken);
      return lease;
    }
    const mergeRequest = (s: Awaited<ReturnType<typeof completedReview>>) => ({
      action: 'merge' as const,
      requestId: randomUUID(),
      publicationId: s.data.publication.id,
      reviewSubjectId: s.review.id,
      expectedSubjectDigest: s.o.seed.material.subjectDigest,
      credentialRevision: 1,
    });
    function remoteMerge(
      s: Awaited<ReturnType<typeof completedReview>>,
      opts: { lost?: boolean; moveBase?: boolean; unprotected?: boolean } = {},
    ) {
      const m = s.o.seed.material,
        M = '9'.repeat(40);
      let merged = false,
        draft = true,
        unavailable = false,
        mergeWrites = 0,
        readyWrites = 0;
      const transport = vi.fn<typeof fetch>(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path === '/graphql') {
          expect(options?.method).toBe('POST');
          expect(JSON.parse(String(options?.body)).variables.id).toBe(
            'PR_synthetic',
          );
          readyWrites++;
          draft = false;
          return new Response(JSON.stringify({ data: {} }));
        }
        if (path.endsWith('/pulls/' + m.remote.number + '/merge')) {
          expect(options?.method).toBe('PUT');
          expect(JSON.parse(String(options?.body))).toEqual({
            sha: m.metadata.commit,
            merge_method: 'merge',
          });
          mergeWrites++;
          if (opts.moveBase) return new Response('{}', { status: 409 });
          merged = true;
          if (opts.lost) {
            unavailable = true;
            throw Error('lost response after commit');
          }
          return new Response(JSON.stringify({ merged: true, sha: M }));
        }
        if (unavailable) return new Response('{}', { status: 503 });
        const raw = path.endsWith('/branches/main/protection')
          ? opts.unprotected
            ? null
            : {
                required_status_checks: {
                  strict: true,
                  checks: repositoryRequiredChecks.map((context) => ({
                    context,
                    app_id: 15368,
                  })),
                },
                enforce_admins: { enabled: true },
                allow_force_pushes: { enabled: false },
                allow_deletions: { enabled: false },
              }
          : path.endsWith('/pulls/' + m.remote.number)
            ? {
                number: m.remote.number,
                html_url: m.remote.url,
                node_id: 'PR_synthetic',
                merged,
                draft,
                state: merged ? 'closed' : 'open',
                merge_commit_sha: merged ? M : null,
                head: {
                  ref: m.remote.branch,
                  sha: m.metadata.commit,
                  repo: { id: platformRepository.id },
                },
                base: {
                  ref: 'main',
                  sha: m.source.baseSha,
                  repo: { id: platformRepository.id },
                },
              }
            : path.endsWith('/git/ref/heads/main')
              ? {
                  ref: 'refs/heads/main',
                  object: { sha: merged ? M : m.source.baseSha },
                }
              : path.endsWith('/git/ref/heads/' + m.remote.branch)
                ? {
                    ref: 'refs/heads/' + m.remote.branch,
                    object: { sha: m.metadata.commit },
                  }
                : path.endsWith('/git/commits/' + M)
                  ? {
                      sha: M,
                      tree: { sha: m.metadata.tree },
                      parents: [
                        { sha: m.source.baseSha },
                        { sha: m.metadata.commit },
                      ],
                    }
                  : {
                      id: platformRepository.id,
                      full_name: platformRepository.fullName,
                    };
        return new Response(JSON.stringify(raw), {
          status: raw === null ? 404 : 200,
        });
      });
      const client = (
        lease: Parameters<typeof repositoryMergeRequestGate>[0],
        readOnly = false,
      ) =>
        new FixedRepositoryGithub(
          () => repositoryMergeRequestGate(lease),
          new AbortController().signal,
          transport,
          readOnly,
        );
      return {
        client,
        transport,
        inspectCi: async () => ({
          observation: s.data.publication.ci,
          evidence: s.data.publication.ci_evidence,
        }),
        recover: () => {
          unavailable = false;
        },
        counts: () => ({ mergeWrites, readyWrites }),
      };
    }
    it('consumes a completed expired review, binds one concurrent request and confirms exact main merge without claiming Dev', async () => {
      const s = await completedReview();
      const proof = await f.db.begin((tx) =>
        readCompletedRepositoryReview(tx, s.internal, s.review.id),
      );
      expect(proof.reviewerRunId).toBe(s.o.child.instance.runId);
      const request = mergeRequest(s),
        results = await Promise.all([
          createPlatformRepositoryMerge(s.admin, request),
          createPlatformRepositoryMerge(s.admin, request),
        ]);
      expect(results[0]!.id).toBe(results[1]!.id);
      expect(results[0]!.actions).toHaveLength(1);
      const lease = await claimMerge(results[0]!.actions[0]!.runId),
        remote = remoteMerge(s);
      const result = await mergeRepositoryCandidate(
        lease,
        new AbortController().signal,
        { github: remote.client(lease), inspectCi: remote.inspectCi },
      );
      expect(result.devDeployed).toBe(false);
      expect(remote.counts()).toEqual({ mergeWrites: 1, readyWrites: 1 });
      await completeJob({ ...lease, result });
      const saved = await getPlatformRepositoryMerge(s.admin, results[0]!.id);
      expect(saved.receipt?.headSha).toBe(s.data.publication.metadata.commit);
      expect(saved.actions[0]!.status).toBe('succeeded');
      const other = await setup();
      await expect(
        getPlatformRepositoryMerge(other.admin, saved.id),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(
        (
          await getPlatformRepositoryMergePanel(
            s.admin,
            s.data.publication.id,
            1,
          )
        ).reason,
      ).toBe('merged');
    }, 30000);
    it('persists one unknown merge intent and reconciles the same actual result under fresh authorization with no second write', async () => {
      const s = await completedReview(),
        request = mergeRequest(s),
        operation = await createPlatformRepositoryMerge(s.admin, request);
      const lease = await claimMerge(operation.actions[0]!.runId),
        remote = remoteMerge(s, { lost: true });
      await expect(
        mergeRepositoryCandidate(lease, new AbortController().signal, {
          github: remote.client(lease),
          inspectCi: remote.inspectCi,
        }),
      ).rejects.toThrow();
      await failJob({
        ...lease,
        code: 'REPOSITORY_MERGE_RESULT_UNKNOWN',
        message: 'Synthetic lost ACK',
        retryable: false,
      });
      expect(
        (await getPlatformRepositoryMerge(s.admin, operation.id)).mergeStarted,
      ).toBe(true);
      await expect(
        createPlatformRepositoryMerge(s.admin, {
          ...request,
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      const replay = await createPlatformRepositoryMerge(s.admin, request);
      expect(replay.actions).toHaveLength(1);
      remote.recover();
      const readback = await createPlatformRepositoryMerge(s.admin, {
        action: 'reconcile',
        requestId: randomUUID(),
        mergeId: operation.id,
        credentialRevision: 1,
      });
      const readLease = await claimMerge(readback.actions[0]!.runId),
        result = await mergeRepositoryCandidate(
          readLease,
          new AbortController().signal,
          {
            github: remote.client(readLease, true),
            inspectCi: remote.inspectCi,
          },
        );
      await completeJob({ ...readLease, result });
      expect(remote.counts()).toEqual({ mergeWrites: 1, readyWrites: 1 });
      expect(
        (await getPlatformRepositoryMerge(s.admin, operation.id)).receipt
          ?.mergeSha,
      ).toBe('9'.repeat(40));
    }, 30000);
    it('rejects missing protection and remote atomic base drift; neither result is accepted as a merge', async () => {
      for (const opts of [{ unprotected: true }, { moveBase: true }]) {
        const s = await completedReview(),
          operation = await createPlatformRepositoryMerge(
            s.admin,
            mergeRequest(s),
          ),
          lease = await claimMerge(operation.actions[0]!.runId),
          remote = remoteMerge(s, opts);
        await expect(
          mergeRepositoryCandidate(lease, new AbortController().signal, {
            github: remote.client(lease),
            inspectCi: remote.inspectCi,
          }),
        ).rejects.toThrow();
        await failJob({
          ...lease,
          code: 'REPOSITORY_MERGE_RESULT_UNKNOWN',
          message: 'Synthetic protection failure',
          retryable: false,
        });
        expect(
          (await getPlatformRepositoryMerge(s.admin, operation.id)).receipt,
        ).toBeNull();
        expect(remote.counts().mergeWrites).toBe(opts.unprotected ? 0 : 1);
      }
    }, 30000);
    it('rejects completed evidence after reviewer cancellation or deleted evidence, and rejects raw merge job admission', async () => {
      const s = await completedReview();
      await expect(
        enqueueRun(s.internal, {
          type: 'allrice.platform.repository.merge',
          workspaceId: s.internal.workspaceId,
          input: {},
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      await f.db`update allrice_assistant_instances set cancel_request_id=${randomUUID()},cancel_requested_at=clock_timestamp() where run_id=${s.o.child.instance.runId}`;
      await expect(
        createPlatformRepositoryMerge(s.admin, mergeRequest(s)),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const second = await completedReview();
      await f.db`delete from allrice_assistant_artifacts where run_id=${second.o.child.instance.runId}`;
      await expect(
        createPlatformRepositoryMerge(second.admin, mergeRequest(second)),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }, 30000);

    it('retains finished review facts across old login/PAT expiry and original/effective report usage differences while requiring new current credentials', async () => {
      const s = await completedReview();
      const [report] =
        await f.db`select * from allrice_assistant_results where run_id=${s.o.child.instance.runId}`;
      await f.db`update allrice_assistant_results set payload_digest=${runtimeLedgerInputDigest({ ...report!.payload, usageComplete: !report!.payload.usageComplete })} where delivery_id=${report!.delivery_id}`;
      await f.db`update allrice_sessions set expires_at=created_at+interval '1 millisecond' where id=${s.admin.sessionId!}`;
      const login = await createSession(s.admin.actor.id),
        fresh = (await authenticatePlatformSession(login.token))!;
      await updatePlatformRepositoryCredential(fresh, {
        action: 'replace',
        requestId: randomUUID(),
        expectedRevision: 1,
        token: 'github_pat_' + 'RotatedSyntheticOnly'.repeat(7),
      });
      const proof = await f.db.begin((tx) =>
        readCompletedRepositoryReview(tx, s.internal, s.review.id),
      );
      expect(proof.reportInputDigest).not.toBe(proof.reportPayloadDigest);
      const [oldJob] = await f.db<
        JobRow[]
      >`select * from allrice_jobs where id=${s.lease.jobId}`;
      expect(
        await f.db.begin((tx) =>
          repositoryReviewCompletionAllowed(tx, oldJob!),
        ),
      ).toBe(false);
      await expect(
        createPlatformRepositoryMerge(fresh, mergeRequest(s)),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const operation = await createPlatformRepositoryMerge(fresh, {
        ...mergeRequest(s),
        credentialRevision: 2,
      });
      const lease = await claimMerge(operation.actions[0]!.runId);
      expect(
        (await repositoryMergeRequestGate(lease)).remainingMs,
      ).toBeGreaterThan(0);
      await failJob({
        ...lease,
        code: 'FIXTURE_COMPLETE',
        message: 'No external effect in this test',
        retryable: false,
      });
    }, 30000);
    it('requires actual report adoption and blocks explicit historical root cancellation even when completion status is retained', async () => {
      for (const fault of ['adoption', 'root-cancel', 'revoke'] as const) {
        const s = await completedReview();
        if (fault === 'adoption')
          await f.db`update allrice_assistant_results set parent_message_id=null where run_id=${s.o.child.instance.runId}`;
        else if (fault === 'root-cancel')
          await f.db`update allrice_runtime_roots set cancel_request_id=${randomUUID()},cancel_requested_at=clock_timestamp(),cancel_reason='user_request' where root_run_id=${s.review.runId}`;
        else
          await f.db`update allrice_assistant_roots set revoked_at=clock_timestamp() where root_run_id=${s.review.runId}`;
        await expect(
          createPlatformRepositoryMerge(s.admin, mergeRequest(s)),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
        expect(
          (await getPlatformRepositoryReview(s.admin, s.review.id)).status,
        ).toBe('succeeded');
      }
    }, 30000);
    it('rejects a new merge lease that expires while waiting for current credential authority', async () => {
      const s = await completedReview(),
        operation = await createPlatformRepositoryMerge(
          s.admin,
          mergeRequest(s),
        ),
        lease = await claimMerge(operation.actions[0]!.runId);
      let locked!: () => void, release!: () => void;
      const acquired = new Promise<void>((r) => {
          locked = r;
        }),
        released = new Promise<void>((r) => {
          release = r;
        });
      const hold = f.db.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`platform-repository-credential:${s.admin.actor.id}:${platformRepository.id}`}))`;
        locked();
        await released;
      });
      await acquired;
      await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()+interval '100 milliseconds' where id=${lease.jobId}`;
      const gate = repositoryMergeRequestGate(lease).then(
        () => ({ allowed: true }),
        (e) => ({ allowed: false, error: e }),
      );
      try {
        await new Promise((r) => setTimeout(r, 200));
        release();
        await hold;
        const outcome = await gate;
        expect(outcome.allowed).toBe(false);
        expect(outcome).toHaveProperty('error.code', 'lease_lost');
      } finally {
        release();
        await hold;
        await gate;
      }
    }, 30000);
    it('rejects an HTTP merge when its current login naturally expires during a publication lock wait', async () => {
      const s = await completedReview(),
        operation = await createPlatformRepositoryMerge(
          s.admin,
          mergeRequest(s),
        ),
        lease = await claimMerge(operation.actions[0]!.runId),
        remote = remoteMerge(s);
      await f.db`update allrice_sessions set expires_at=clock_timestamp()+interval '2 seconds' where id=${s.admin.sessionId!}`;
      let locked!: () => void, release!: () => void;
      const acquired = new Promise<void>((r) => {
          locked = r;
        }),
        released = new Promise<void>((r) => {
          release = r;
        });
      const hold = f.db.begin(async (tx) => {
        await tx`select id from allrice_platform_repository_publications where id=${s.data.publication.id} for update`;
        locked();
        await released;
      });
      await acquired;
      const request = remote
        .client(lease)
        .mergeExactPull(
          s.o.seed.material.remote.number,
          s.o.seed.material.metadata.commit,
        )
        .then(
          () => ({ allowed: true }),
          (error) => ({ allowed: false, error }),
        );
      try {
        await vi.waitFor(
          async () => {
            const [waiting] =
              await f.db`select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and query like '%allrice_platform_repository_publications%'`;
            expect(waiting!.n).toBeGreaterThan(0);
          },
          { timeout: 5000, interval: 25 },
        );
        await vi.waitFor(
          async () => {
            const [login] =
              await f.db`select expires_at<=clock_timestamp() as expired from allrice_sessions where id=${s.admin.sessionId!}`;
            expect(login!.expired).toBe(true);
          },
          { timeout: 5000, interval: 25 },
        );
        release();
        await hold;
        expect((await request).allowed).toBe(false);
        expect(remote.counts().mergeWrites).toBe(0);
        expect(remote.transport).not.toHaveBeenCalled();
      } finally {
        release();
        await hold;
        await request;
        await failJob({
          ...lease,
          code: 'FIXTURE_COMPLETE',
          message: 'No HTTP write after expired login',
          retryable: false,
        });
      }
    }, 30000);

    it('allows a new completed CI review after pre-START failure, preserves old request evidence and rejects proof replacement after any START', async () => {
      for (const effect of [null, 'ready', 'merge'] as const) {
        const s = await completedReview(),
          request = mergeRequest(s),
          old = await createPlatformRepositoryMerge(s.admin, request),
          lease = await claimMerge(old.actions[0]!.runId);
        if (effect) {
          const m = s.o.seed.material;
          await startRepositoryMergeEffect(lease, effect, {
            policy: {
              version: 1,
              kind: 'strict_protected_main',
              digest: technicalDigest({ strict: true }),
            },
            ci: m.ci,
            pull: {
              number: m.remote.number,
              url: m.remote.url,
              headSha: m.metadata.commit,
              baseSha: m.source.baseSha,
              draft: effect === 'ready',
              state: 'open',
              nodeId: 'PR_synthetic',
              merged: false,
              mergeSha: null,
            },
          });
        }
        await failJob({
          ...lease,
          code: 'FIXTURE_PRECHECK',
          message: 'Stop without replaying any external write',
          retryable: false,
        });
        const next = await completeReview(await rerunReview(s));
        expect(next.o.seed.material.subjectDigest).not.toBe(
          s.o.seed.material.subjectDigest,
        );
        expect(
          (await findPlatformRepositoryMerge(s.admin, request.requestId))!
            .reviewSubjectId,
        ).toBe(s.review.id);
        const panel = await getPlatformRepositoryMergePanel(
          s.admin,
          s.data.publication.id,
          1,
        );
        if (effect) {
          expect(panel.canStart).toBe(false);
          await expect(
            createPlatformRepositoryMerge(s.admin, mergeRequest(next)),
          ).rejects.toMatchObject({ code: 'conflict' });
        } else {
          expect(panel.canStart).toBe(false);
          expect(panel.reason).toBe('automatic_merge_disabled');
          const current = await createPlatformRepositoryMerge(
            s.admin,
            mergeRequest(next),
          );
          expect(current.id).not.toBe(old.id);
          expect(current.reviewSubjectId).toBe(next.review.id);
          expect(
            (await createPlatformRepositoryMerge(s.admin, request)).id,
          ).toBe(old.id);
          expect(
            (await getPlatformRepositoryMerge(s.admin, old.id)).reviewSubjectId,
          ).toBe(s.review.id);
          const currentLease = await claimMerge(current.actions[0]!.runId),
            remote = remoteMerge(next);
          const result = await mergeRepositoryCandidate(
            currentLease,
            new AbortController().signal,
            {
              github: remote.client(currentLease),
              inspectCi: remote.inspectCi,
            },
          );
          await completeJob({ ...currentLease, result });
          expect(remote.counts().mergeWrites).toBe(1);
        }
      }
    }, 60000);

    it('fences current private scope revocation across a publication lock wait and rejects the next request after revocation commits', async () => {
      const s = await completedReview(),
        operation = await createPlatformRepositoryMerge(
          s.admin,
          mergeRequest(s),
        ),
        lease = await claimMerge(operation.actions[0]!.runId);
      let locked!: () => void, release!: () => void;
      const acquired = new Promise<void>((r) => {
          locked = r;
        }),
        released = new Promise<void>((r) => {
          release = r;
        });
      const hold = f.db.begin(async (tx) => {
        await tx`select id from allrice_platform_repository_publications where id=${s.data.publication.id} for update`;
        locked();
        await released;
      });
      await acquired;
      let gateDone = false,
        revoked = false;
      const gate = repositoryMergeRequestGate(lease).finally(() => {
        gateDone = true;
      });
      try {
        await vi.waitFor(
          async () => {
            const [waiting] =
              await f.db`select count(*)::int as n from pg_stat_activity where wait_event_type='Lock' and query like '%allrice_platform_repository_publications%'`;
            expect(waiting!.n).toBeGreaterThan(0);
          },
          { timeout: 5000, interval: 25 },
        );
        const revoke =
          f.db`update allrice_memberships set active=false where user_id=${s.admin.actor.id} and organization_id=${s.internal.organizationId}`.then(
            () => {
              revoked = true;
            },
          );
        await new Promise((r) => setTimeout(r, 80));
        expect(gateDone).toBe(false);
        expect(revoked).toBe(false);
        release();
        await hold;
        expect((await gate).remainingMs).toBeGreaterThan(0);
        await revoke;
        await expect(repositoryMergeRequestGate(lease)).rejects.toThrow();
      } finally {
        release();
        await hold;
        await gate.catch(() => undefined);
      }
    }, 30000);

    it('serializes actual same-content revise registration with historical proof consumption and preserves the rejection after its Job fails', async () => {
      const s = await completedReview(),
        next = await rerunReview(s);
      expect(
        (
          await f.db.begin((tx) =>
            readCompletedRepositoryReview(tx, s.internal, s.review.id),
          )
        ).material.candidateContentDigest,
      ).toBe(s.o.seed.material.candidateContentDigest);
      let locked!: () => void, release!: () => void;
      const acquired = new Promise<void>((r) => {
          locked = r;
        }),
        released = new Promise<void>((r) => {
          release = r;
        });
      const hold = f.db.begin(async (tx) => {
        await lockRepositoryReviewContent(
          tx,
          s.admin.actor.id,
          s.o.seed.material.candidateContentDigest,
        );
        locked();
        await released;
      });
      await acquired;
      let writerDone = false,
        readerDone = false;
      const writer = opinion(next, 'revise').finally(() => {
        writerDone = true;
      });
      // Wait for the real registered callback to queue on the shared mutex.
      await vi.waitFor(
        async () => {
          const [wait] =
            await f.db`select count(*)::int as n from pg_stat_activity where wait_event='advisory' and query like '%pg_advisory_xact_lock(hashtextextended%'`;
          expect(wait!.n).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 },
      );
      const reader = f.db
        .begin((tx) =>
          readCompletedRepositoryReview(tx, s.internal, s.review.id),
        )
        .then(
          () => ({ allowed: true }),
          (e) => ({ allowed: false, error: e }),
        )
        .finally(() => {
          readerDone = true;
        });
      try {
        await new Promise((r) => setTimeout(r, 80));
        expect(writerDone).toBe(false);
        expect(readerDone).toBe(false);
        release();
        await hold;
        await writer;
        expect((await reader).allowed).toBe(false);
        await failJob({
          ...next.lease,
          code: 'FIXTURE_REVISE',
          message: 'Keep actual rejection even when final Job fails',
          retryable: false,
        });
        await expect(
          f.db.begin((tx) =>
            readCompletedRepositoryReview(tx, s.internal, s.review.id),
          ),
        ).rejects.toMatchObject({ code: 'authorization_denied' });
      } finally {
        release();
        await hold;
        await writer;
        await reader;
      }
    }, 30000);

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
