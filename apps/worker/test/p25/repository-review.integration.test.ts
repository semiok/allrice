import type { RepositoryReviewArtifactRef } from '../../../../packages/database/src/platform-repository-review-contracts.ts';
import { createReadPathProbe } from '../../../../packages/database/src/read-path-probe.fixture.ts';
import { readRetiredExecutionHistory } from './retired-execution-history.fixture.ts';
import {
  expectReadPathRowLocked,
  readPathSignal,
  scheduleReadPathQuery,
} from '../../../../packages/database/src/read-path-races.fixture.ts';
import type { RuntimeLedgerTransaction } from '../../../../packages/database/src/runtime-ledger/types.ts';
import { getPlatformRepositoryCredential } from '../../../../packages/database/src/platform-repository-credentials.ts';
/** Real isolated PostgreSQL/Job/storage. Remote CI is synthetic; Worker cases
 * use the real DSH Host with a synthetic HTTP model and credential. */
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import {
  installDshNativeArtifact,
  measureDshNativeArtifact,
  nativeArtifactPath,
} from '../../src/harness/dsh-native-artifact.js';
import JSZip from 'jszip';
import { repositoryDigest } from '../../../../packages/database/src/platform-repository-source.ts';
import { RepositoryCompletedReviewSchema } from '../../../../packages/database/src/platform-repository-merge-contracts.ts';
import * as modelPool from '../../../../packages/database/src/providers/model-pool.ts';
import * as harnessRouter from '../../src/harness/router.js';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.js';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.js';
import * as queue from '../../../../packages/database/src/execution/queue.ts';
import { createTaskProgressRuntime } from '../../../../packages/database/src/task-progress.ts';
import { refreshTaskClock } from '../../../../packages/database/src/task-clock.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.js';
import { runClaimedJob } from '../../src/job-runner.js';
import { p24Fixture } from '../p24/fixture.js';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  PlatformEmployeeDefinitionSchema,
  type RequestContext,
} from '@allrice/contracts';
import * as client from '../../../../packages/database/src/core/client.ts';
import {
  createRuntimeFixtureDatabase,
  runtimeFixtureStorage,
} from '../../../../packages/database/src/runtime.fixture.ts';
import { createExperienceFixture } from '../../../../packages/database/src/experience.fixture.ts';
import {
  ensureBootstrapPortalPrincipal,
  createSession,
  authenticatePlatformSession,
} from '../../../../packages/database/src/identity.ts';
import {
  savePlatformEmployeeDraft,
  publishPlatformEmployee,
  disablePlatformEmployee,
  materializePlatformEmployeeRevision,
} from '../../../../packages/database/src/employees/platform-employees.ts';
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
import { type RepositoryReviewMaterial } from '../../../../packages/database/src/platform-repository-review-contracts.ts';
import {
  enqueueRun,
  claimNextJob,
  startClaimedJob,
  completeJob,
  heartbeatJob,
} from '../../../../packages/database/src/execution/queue.ts';
import { executeRepositoryReview } from '../../../../packages/database/src/platform-repository-development.ts';

import { lockRepositoryReviewContent } from '../../../../packages/database/src/platform-repository-review-facts.ts';
import { repositoryReviewCompletionAllowed } from '../../../../packages/database/src/platform-repository-review-authority.ts';
import type { JobRow } from '../../../../packages/database/src/queue/row-mappers.ts';
import { repositoryMergeRequestGate } from '../../../../packages/database/src/platform-repository-merge-authority.ts';
import { readCompletedRepositoryReview } from '../../../../packages/database/src/platform-repository-completed-review.ts';
import {
  createPlatformRepositoryMerge,
  cancelPlatformRepositoryMerge,
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

// Diagnostic barriers schedule real RPC/PG work; they never manufacture an
// abort, a heartbeat result, a progress receipt or a successful close.
async function closeOrderingBarrier(promise: Promise<void>, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error(`close_ordering_${label}`)),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function closeOrderingError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: Reflect.get(error, 'code'),
    evidence: Reflect.get(error, 'evidence'),
    cause: error.cause ? closeOrderingError(error.cause) : undefined,
    errors:
      error instanceof AggregateError
        ? error.errors.map(closeOrderingError)
        : undefined,
  };
}

// Schedule real SQL on separate pooled connections, preserving SQL fragments.
// Barriers choose the interleaving; PostgreSQL proves the actual lock wait.
function reviewLockConnection(
  db: ReturnType<typeof client.getDatabase>,
  hook: (input: {
    sql: string;
    execute: () => Promise<unknown>;
    tx: RuntimeLedgerTransaction;
    pid: number;
  }) => Promise<unknown>,
) {
  const trace = { transactions: 0, pids: new Set<number>() };
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key !== 'begin') return Reflect.get(target, key, target);
      return (...args: unknown[]) => {
        const work = args.at(-1) as (tx: RuntimeLedgerTransaction) => unknown;
        const run = async (tx: RuntimeLedgerTransaction) => {
          trace.transactions++;
          const [backend] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() as pid`;
          const pid = backend!.pid;
          trace.pids.add(pid);
          return work(
            new Proxy(tx, {
              apply(sqlTarget, self, values: unknown[]) {
                const query = Reflect.apply(
                  sqlTarget,
                  self,
                  values,
                ) as PromiseLike<unknown>;
                const [strings] = values;
                if (!Array.isArray(strings) || !('raw' in strings))
                  return query;
                return scheduleReadPathQuery(
                  query,
                  strings.join(' $ '),
                  (sql, execute) => hook({ sql, execute, tx, pid }),
                );
              },
            }),
          );
        };
        return args.length > 1
          ? target.begin(args[0] as string, run)
          : target.begin(run);
      };
    },
  });
  return { db: wrapped, trace };
}

suite(
  'platform repository review native workflow and current authority',
  () => {
    let f: Awaited<ReturnType<typeof createRuntimeFixtureDatabase>>;
    let platformEmployeeId: string;
    const emails = new Set<string>();
    let manifestPath: string, previousManifest: Buffer | undefined;
    const testHarnessExecArgv = process.execArgv;
    beforeAll(async () => {
      const root = await realpath(resolve(import.meta.dirname, '../../../..'));
      const artifact = await measureDshNativeArtifact(root, undefined, {
        schemaVersion: 2,
      });
      manifestPath = join(root, nativeArtifactPath);
      previousManifest = await readFile(manifestPath).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        },
      );
      await mkdir(join(root, '.local'), { recursive: true });
      await writeFile(manifestPath, JSON.stringify(artifact));
      // Vitest's require shim is not a Worker loader. Exact content verification
      // and native launch approval remain real, as in dsh-idle-recovery-worker.
      process.execArgv = [];
      vi.stubEnv('NODE_OPTIONS', '');
      await installDshNativeArtifact({ root, expectedId: artifact.artifactId });
      vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifact.artifactId);
      vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifact.artifactId);
      f = await createRuntimeFixtureDatabase();
      vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
      vi.stubEnv('ALLRICE_ENV', 'development');
      vi.stubEnv('ALLRICE_MCP_CREDENTIAL_KEY', 'a'.repeat(64));
      vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_STORAGE_ROOT', f.storageRoot);
      for (const flag of ['WORKBENCH', 'RUNTIME_POLICY'])
        vi.stubEnv(`ALLRICE_${flag}_ENABLED`, '1');
      await createExperienceFixture(f.db);
      await f.db`update allrice_model_connections set status='ready' where id='52000000-0000-4000-8000-000000000001'`;
      await f.db`update allrice_model_providers set enabled=true where provider_key='codex'`;
      const [revision] =
        await f.db`select r.* from allrice_platform_employee_revisions r join allrice_platform_employees e on e.current_published_revision_id=r.id where e.employee_key='rice'`;
      platformEmployeeId = revision!.employee_id as string;
      const toolNames = [
        'workspace.project',
        'browser.workspace',
        'workspace.export.create',
      ];
      const definition = PlatformEmployeeDefinitionSchema.parse({
        ...revision!.definition,
        // The synthetic review workflow includes local.process.execute.
        securityPolicy: {
          ...revision!.definition.securityPolicy,
          bridgeAccess: 'read_write',
        },
        capabilities: {
          ...revision!.definition.capabilities,
          nativeSkillIds: [],
          explicitToolNames: toolNames,
          toolNames,
        },
      });
      await savePlatformEmployeeDraft(revision!.employee_id, { definition });
      const publication = await publishPlatformEmployee(revision!.employee_id, {
        scope: 'assigned',
      });
      expect(publication.errors).toEqual([]);
      expect(publication.valid).toBe(true);
    }, 120000);
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        if (manifestPath) {
          if (previousManifest) await writeFile(manifestPath, previousManifest);
          else await rm(manifestPath, { force: true });
        }
        process.execArgv = testHarnessExecArgv;
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
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
      const archives = new Map<number, Buffer>();
      for (const e of data.publication.ci_evidence) {
        const zip = new JSZip();
        zip.file('receipt.json', JSON.stringify(e.receipt));
        const bytes = await zip.generateAsync({ type: 'nodebuffer' });
        archives.set(e.artifactId, bytes);
        e.archiveDigest = repositoryDigest(bytes);
      }
      data.publication.ci.receipts = data.publication.ci_evidence.map((e) => ({
        name: e.receipt.job,
        artifactId: e.artifactId,
        archiveDigest: e.archiveDigest,
        receiptDigest: technicalDigest(e.receipt),
      }));
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
      return { admin, internal, data, create, panel, archives };
    }
    function repositoryTransport(s: Awaited<ReturnType<typeof setup>>) {
      const p = s.data.publication;
      const run = {
        id: 100,
        run_attempt: 1,
        workflow_id: 10,
        head_sha: p.metadata.commit,
        head_branch: p.remote.branch,
        event: 'pull_request',
        path: '.github/workflows/ci.yml',
        repository: { id: platformRepository.id },
        head_repository: { id: platformRepository.id },
        status: 'completed',
        conclusion: 'success',
      };
      return vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (url, options) => {
          const u = new URL(String(url)),
            path = u.pathname;
          expect(options?.method ?? 'GET').toBe('GET');
          if (u.hostname === 'fixture.blob.core.windows.net') {
            const bytes = s.archives.get(Number(path.slice(1)));
            if (!bytes) throw Error('Unexpected synthetic artifact');
            return new Response(Uint8Array.from(bytes));
          }
          expect(u.hostname).toBe('api.github.com');
          const archive = /\/actions\/artifacts\/(\d+)\/zip$/.exec(path);
          if (archive)
            return new Response(null, {
              status: 302,
              headers: {
                location: `https://fixture.blob.core.windows.net/${archive[1]}`,
              },
            });
          if (path.endsWith('/pulls'))
            return new Response(
              JSON.stringify([
                {
                  number: p.remote.number,
                  html_url: p.remote.url,
                  draft: true,
                  state: 'open',
                  head: {
                    ref: p.remote.branch,
                    sha: p.metadata.commit,
                    repo: { id: platformRepository.id },
                  },
                  base: {
                    ref: 'main',
                    sha: p.source.baseSha,
                    repo: { id: platformRepository.id },
                  },
                },
              ]),
            );
          if (path.endsWith('/git/ref/heads/main'))
            return new Response(
              JSON.stringify({
                ref: 'refs/heads/main',
                object: { sha: p.source.baseSha },
              }),
            );
          if (path.endsWith('/git/ref/heads/' + p.remote.branch))
            return new Response(
              JSON.stringify({
                ref: 'refs/heads/' + p.remote.branch,
                object: { sha: p.metadata.commit },
              }),
            );
          const value = path.endsWith('/actions/workflows/ci.yml')
            ? { id: 10, path: '.github/workflows/ci.yml', state: 'active' }
            : path.endsWith('/actions/workflows/ci.yml/runs')
              ? { total_count: 1, workflow_runs: [run] }
              : path.endsWith('/actions/runs/100')
                ? run
                : path.endsWith('/actions/runs/100/attempts/1/jobs')
                  ? {
                      total_count: 4,
                      jobs: p.ci.checks.map((c) => ({
                        id: c.id,
                        name: c.name,
                        status: 'completed',
                        conclusion: 'success',
                        steps: [
                          {
                            name: 'Record complete original CI gate',
                            conclusion: 'success',
                          },
                          {
                            name: 'Build all workspace production packages',
                            conclusion: 'success',
                          },
                        ],
                      })),
                    }
                  : path.endsWith('/actions/runs/100/artifacts')
                    ? {
                        total_count: 4,
                        artifacts: p.ci_evidence.map((e) => ({
                          id: e.artifactId,
                          name: `repository-ci-${e.receipt.job}-1`,
                          expired: false,
                          size_in_bytes: s.archives.get(e.artifactId)!.length,
                          digest: e.archiveDigest,
                          workflow_run: {
                            id: 100,
                            repository_id: platformRepository.id,
                            head_repository_id: platformRepository.id,
                            head_sha: p.metadata.commit,
                          },
                        })),
                      }
                    : null;
          if (!value) throw Error('Unexpected synthetic GitHub read: ' + path);
          return new Response(JSON.stringify(value));
        });
    }

    it.each([
      'accept',
      'revise',
      'missing-review',
      'question-attempt',
      'cancel',
      'revoked',
      'revoked close ordering: heartbeat',
      'revoked close ordering: modelAdmission',
    ] as const)(
      '真实入口 → Worker → DSH → PG，无助手：%s',
      async (mode) => {
        const closeOrdering = mode.startsWith('revoked close ordering:');
        const heartbeatFirst = mode === 'revoked close ordering: heartbeat';
        const modelAdmissionFirst =
          mode === 'revoked close ordering: modelAdmission';
        const toolStarted = readPathSignal();
        const activeHeartbeat = readPathSignal();
        const runnerAborted = readPathSignal();
        const trace: Record<string, unknown>[] = [];
        const mark = (event: string, details: Record<string, unknown> = {}) =>
          trace.push({ event, at: performance.now(), ...details });
        const nativeClients = new Set<DshProtocolClient>();
        const unsubscribe: (() => void)[] = [];
        const legacyHistory = await readRetiredExecutionHistory(f.db);
        const s = await setup();
        let review!: Awaited<ReturnType<typeof s.create>>;
        const command = (args: Record<string, unknown>) => ({
          nativeTool: { name: 'platform_repository_review', arguments: args },
        });
        let candidate: RepositoryReviewArtifactRef;
        const model = await p24Fixture(async (request, index) => {
          // Inspect the complete real profile, including tools that the Host
          // does not forward through the AllRice Broker.
          expect(request.tools?.map((t) => t.function.name)).toEqual([
            'platform_repository_review',
          ]);
          if (index === 1) {
            // Observe an unchanged, real 1s heartbeat before releasing this
            // control's model response. If admission still loses the race,
            // the explicit branch assertion below must fail, never relabel it.
            if (modelAdmissionFirst)
              await closeOrderingBarrier(
                activeHeartbeat.promise,
                'active_heartbeat',
              );
            if (mode === 'missing-review') return { text: '已经审查通过。' };
            if (mode === 'question-attempt')
              return {
                nativeTool: {
                  name: 'ask_user_question',
                  arguments: {
                    questions: [
                      {
                        id: 'continue',
                        question: '是否继续复核？',
                        options: [{ label: '继续' }],
                      },
                    ],
                  },
                },
              };
            if (mode === 'cancel') {
              await cancelPlatformRepositoryReview(s.admin, review.id);
              return { text: '停止。' };
            }
            if (mode === 'revoked') {
              await f.db`update allrice_employee_assignments set active=false where id=(select employee_assignment_id from allrice_employee_runs where run_id=${review.runId})`;
            }
            return command({ action: 'inspect' });
          }
          // A native failure is an ordinary DSH tool result. Finish the turn;
          // the unchanged Job completion authority must reject this review.
          if (
            mode === 'revoked' ||
            closeOrdering ||
            mode === 'question-attempt'
          )
            return { text: '未取得复核意见。' };
          const result = request.messages
            .filter((m) => m.role === 'tool')
            .at(-1);
          expect(result?.content).toBeTypeOf('string');
          const facts = JSON.parse(result!.content as string);
          if (index === 2) {
            candidate = facts.candidate;
            expect(facts.material.authorRunIds).not.toContain(review.runId);
            return command({
              action: 'review',
              candidate,
              evidence: facts.evidence,
              verdict: mode === 'revise' ? 'revise' : 'accept',
              summary:
                'Synthetic model opinion for the exact persisted candidate',
            });
          }
          if (index === 3 && mode !== 'revise')
            return command({
              action: 'deliver',
              candidate,
              reviewId: facts.id,
            });
          return { text: '固定候选审查完成，意见已保存。' };
        });
        const adapter = new DshHarnessAdapter({
          runtimeRoot: join(f.storageRoot, 'review-native-' + randomUUID()),
          credentialResolver: {
            resolve: async () => ({ apiKey: 'synthetic-only' }),
          },
          requestTimeoutMs: 15000,
        });
        const router = vi
          .spyOn(harnessRouter, 'getHarnessRouter')
          .mockReturnValue(new harnessRouter.HarnessRouter([adapter]));
        const originalFreeze = modelPool.freezeSessionModelSnapshot;
        // Only replace the model target/credential. The complete request,
        // private deployment, native execution binding and queue stay real.
        const freeze = vi
          .spyOn(modelPool, 'freezeSessionModelSnapshot')
          .mockImplementation(async (...args) => ({
            ...(await originalFreeze(...args)),
            provider: 'openai-compatible',
            authMode: 'api_key',
            model: 'p24-synthetic',
            reasoningEffort: 'low',
            credentialReference: 'test:synthetic',
            baseUrl: model.baseUrl,
          }));
        const remote = repositoryTransport(s);
        const actualHeartbeat = queue.heartbeatJob;
        const heartbeatObserver = closeOrdering
          ? vi
              .spyOn(queue, 'heartbeatJob')
              .mockImplementation(async (...args) => {
                try {
                  const result = await actualHeartbeat(...args);
                  mark('heartbeat', { result });
                  if (result.active) activeHeartbeat.resolve();
                  return result;
                } catch (error) {
                  mark('heartbeat_failed', {
                    error: closeOrderingError(error),
                  });
                  throw error;
                }
              })
          : undefined;
        const actualSetHandler = DshProtocolClient.prototype.setRequestHandler;
        let interceptedTool = false;
        const handlerObserver = closeOrdering
          ? vi
              .spyOn(DshProtocolClient.prototype, 'setRequestHandler')
              .mockImplementation(function (this: DshProtocolClient, handler) {
                if (handler && !nativeClients.has(this)) {
                  nativeClients.add(this);
                  const child = Reflect.get(
                    this,
                    'child',
                  ) as ChildProcessWithoutNullStreams;
                  mark('host', { pid: child.pid });
                  // This fixture uses only synthetic credentials. Keep stderr
                  // test-local; production deliberately discards this channel.
                  child.stderr.on('data', (chunk: Buffer) =>
                    mark('host_stderr', { text: chunk.toString() }),
                  );
                  let buffered = '';
                  child.stdout.on('data', (chunk: Buffer) => {
                    buffered += chunk.toString();
                    const lines = buffered.split('\n');
                    buffered = lines.pop()!;
                    for (const line of lines) {
                      try {
                        const frame = JSON.parse(line);
                        if (frame.result?.allriceClose)
                          mark('shutdown_receipt', {
                            receipt: frame.result.allriceClose,
                          });
                      } catch {
                        /* The protocol client owns malformed frames. */
                      }
                    }
                  });
                  unsubscribe.push(
                    this.subscribe(({ method, params }) => {
                      if (JSON.stringify(params).includes('turn/end'))
                        mark('native_turn_end', { method, params });
                    }),
                  );
                }
                actualSetHandler.call(
                  this,
                  handler &&
                    (async (method, params) => {
                      const details = {
                        method,
                        action: params.action,
                        kind: params.kind,
                        callId: params.callId,
                        nativeSessionId: params.nativeSessionId,
                      };
                      try {
                        if (
                          method === 'allrice/tool-call' &&
                          !interceptedTool
                        ) {
                          interceptedTool = true;
                          await closeOrderingBarrier(
                            toolStarted.promise,
                            'tool_start',
                          );
                          await f.db`update allrice_employee_assignments set active=false where id=(select employee_assignment_id from allrice_employee_runs where run_id=${review.runId})`;
                          mark('assignment_revoked');
                          try {
                            return await handler(method, params);
                          } catch (error) {
                            mark('tool_gate_refused', {
                              error: closeOrderingError(error),
                            });
                            throw error;
                          } finally {
                            if (heartbeatFirst) {
                              // Hold the already dispatched tool's real reply
                              // until the unchanged runner heartbeat aborts it.
                              await closeOrderingBarrier(
                                runnerAborted.promise,
                                'runner_abort',
                              );
                              const [job] =
                                await f.db`select status,worker_id,lease_token,drain_deadline_at,last_error_code from allrice_jobs where id=${review.jobId}`;
                              mark('job_at_abort', { job });
                            }
                            mark('tool_reply_released');
                          }
                        }
                        const result = await handler(method, params);
                        if (method === 'allrice/progress') {
                          mark('progress_ok', details);
                          if (
                            params.action === 'start' &&
                            params.kind === 'tool'
                          )
                            toolStarted.resolve();
                        }
                        return result;
                      } catch (error) {
                        mark('rpc_failed', {
                          ...details,
                          error: closeOrderingError(error),
                        });
                        throw error;
                      }
                    }),
                );
              })
          : undefined;
        const oldHome = process.env.ALLRICE_DSH_PLATFORM_HOME;
        vi.stubEnv(
          'ALLRICE_DSH_PLATFORM_HOME',
          join(f.storageRoot, 'synthetic-platform-home'),
        );
        try {
          review = await s.create();
          const [stored] =
            await f.db`select payload from allrice_jobs where id=${review.jobId}`;
          expect(stored!.payload.input).not.toHaveProperty(
            'assistantConfiguration',
          );
          const workerId = randomUUID(),
            job = await claimNextJob(workerId, 60000);
          expect(job!.id).toBe(review.jobId);
          await runClaimedJob(
            {
              workerId,
              jobId: job!.id,
              leaseToken: job!.lease!.token,
              leaseMs: 60000,
              heartbeatMs: 1000,
              executionRoot: join(f.storageRoot, 'executions'),
              stopping: () => false,
              onAbortReady: () => {},
            },
            async (input) => {
              input.signal.addEventListener(
                'abort',
                () => {
                  mark('runner_aborted');
                  runnerAborted.resolve();
                },
                { once: true },
              );
              return executeEmployeeRun(input);
            },
          );
          const detail = await getPlatformRepositoryReview(s.admin, review.id);
          const [diagnostic] =
            await f.db`select last_error_code,last_error_message from allrice_jobs where id=${review.jobId}`;
          expect(detail.status, JSON.stringify(diagnostic)).toBe(
            mode === 'accept' || mode === 'revise'
              ? 'succeeded'
              : mode === 'cancel'
                ? 'canceled'
                : 'failed',
          );
          expect(model.requests.length).toBeGreaterThan(0);
          expect(JSON.stringify(model.requests)).not.toContain(
            '<allrice_tool_call>',
          );
          expect(JSON.stringify(model.requests)).not.toContain(
            '<allrice_tool_result>',
          );
          if (mode === 'question-attempt') {
            expect(
              await f.db`select question_id from allrice_task_questions where run_id=${review.runId}`,
            ).toHaveLength(0);
            expect(
              await f.db`select run_id from allrice_native_question_waits where run_id=${review.runId}`,
            ).toHaveLength(0);
            await expect(
              getPlatformRepositoryReviewPanel(
                s.admin,
                s.data.publication.id,
                1,
              ),
            ).resolves.toHaveProperty('reviews.0.status', 'failed');
          }
          const artifacts =
            await f.db`select w.run_id,o.state,o.checksum from allrice_workbench_artifacts w join allrice_deliverable_versions v on v.id=w.version_id join allrice_storage_objects o on o.id=v.object_id where w.run_id=${review.runId}`;
          expect(artifacts).toHaveLength(
            mode === 'accept' ? 3 : mode === 'revise' ? 2 : 0,
          );
          if (mode === 'accept' || mode === 'revise') {
            expect(detail.verdict).toBe(
              mode === 'revise' ? 'revise' : 'accept',
            );
            expect(detail.reviewerRunId).toBe(review.runId);
            expect(
              artifacts.every(
                (a) => a.state === 'ready' && /^sha256:/.test(a.checksum),
              ),
            ).toBe(true);
            expect(detail.remoteVerifiedAt).not.toBeNull();
            expect(model.requests).toHaveLength(mode === 'revise' ? 3 : 4);
            const calls = await f.db`select payload from allrice_run_events
              where run_id=${review.runId} and event_type='tool.completed'
                and payload->>'source'='platform_repository_review' order by sequence`;
            expect(calls.map((c) => c.payload)).toEqual(
              (mode === 'revise'
                ? ['inspect', 'review']
                : ['inspect', 'review', 'deliver']
              ).map((action, index) => ({
                name: 'platform.repository.review',
                toolCallId: `call-${index + 1}`,
                source: 'platform_repository_review',
                action,
              })),
            );
          }
          expect(await readRetiredExecutionHistory(f.db)).toEqual(
            legacyHistory,
          );
          if (closeOrdering) {
            expect(trace.some((row) => row.event === 'tool_gate_refused')).toBe(
              true,
            );
            expect(trace.some((row) => row.event === 'runner_aborted')).toBe(
              heartbeatFirst,
            );
            expect(
              trace.some(
                (row) =>
                  row.event === 'rpc_failed' &&
                  row.method === 'allrice/progress' &&
                  (row.action === 'model_prepare' ||
                    (row.action === 'start' && row.kind === 'model')),
              ),
            ).toBe(modelAdmissionFirst);
            expect(diagnostic!.last_error_code).toBe(
              heartbeatFirst
                ? 'PLATFORM_TECHNICAL_AUTH_REVOKED'
                : 'EMPLOYEE_CONTENT_UNAVAILABLE',
            );
            if (heartbeatFirst) {
              const stopped = trace.find(
                (row) => row.event === 'job_at_abort',
              )!;
              expect(stopped.job).toMatchObject({
                status: 'running',
                worker_id: workerId,
                lease_token: job!.lease!.token,
                drain_deadline_at: expect.any(Date),
              });
            }
            expect(
              trace.some(
                (row) =>
                  row.event === 'progress_ok' &&
                  row.action === 'finish' &&
                  row.kind === 'tool' &&
                  row.callId === 'call-1',
              ),
            ).toBe(true);
            const [call] =
              await f.db`select finished_at,outcome from allrice_task_calls where run_id=${review.runId} and kind='tool' and call_id='call-1'`;
            expect(call).toEqual({
              finished_at: expect.any(Date),
              outcome: 'error',
            });
          }
        } finally {
          try {
            await adapter.close().catch((error) => {
              if (closeOrdering)
                mark('adapter_close_failed', {
                  error: closeOrderingError(error),
                });
              throw error;
            });
            if (closeOrdering)
              for (const native of nativeClients)
                expect(native.closureEvidence()).toMatchObject({
                  shutdownAcknowledged: true,
                  wrapperCleanupConfirmed: true,
                  terminationAttempted: null,
                  process: {
                    state: 'exited',
                    stdioClosed: true,
                    exitCode: 0,
                    signal: null,
                  },
                });
          } finally {
            if (closeOrdering && review) {
              for (const native of nativeClients)
                mark('closure_evidence', {
                  evidence: native.closureEvidence(),
                });
              const [job] =
                await f.db`select status,worker_id,lease_token,drain_deadline_at,last_error_code from allrice_jobs where id=${review.jobId}`;
              const progress =
                await f.db`select state from allrice_task_progress where run_id=${review.runId}`;
              mark('final_pg', { job, progress });
              console.info(
                '[revoked-close-ordering]',
                JSON.stringify({ mode, trace }),
              );
            }
            for (const stop of unsubscribe) stop();
            handlerObserver?.mockRestore();
            heartbeatObserver?.mockRestore();
            await model.close();
            remote.mockRestore();
            freeze.mockRestore();
            router.mockRestore();
            vi.stubEnv('ALLRICE_DSH_PLATFORM_HOME', oldHome);
          }
        }
      },
      60000,
    );

    it('denies a non-admin review request and rejects raw or assistant-configured review Job admission', async () => {
      const s = await setup();
      const original = process.env.ALLRICE_PLATFORM_ADMIN_EMAILS;
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', '');
      try {
        await expect(s.create()).rejects.toMatchObject({
          code: 'authorization_denied',
        });
      } finally {
        vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', original);
      }
      await expect(
        enqueueRun(s.internal, {
          type: 'allrice.employee.run',
          workspaceId: s.internal.workspaceId,
          idempotencyKey: randomUUID(),
          input: {
            repositoryReviewRequestId: randomUUID(),
            assistantConfiguration: { allowAssistants: true },
          },
        }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      expect(
        await f.db`select id from allrice_platform_repository_review_subjects where owner_id=${s.admin.actor.id}`,
      ).toHaveLength(0);
    });

    it('0229 retains both ordinary reviewer Run FKs from 0228', async () => {
      const rows =
        await f.db`select c.conrelid::regclass::text relation,c.confrelid::regclass::text target
        from pg_constraint c where c.connamespace=(select oid from pg_namespace where nspname=current_schema()) and c.contype='f' and
        (c.conrelid in ('allrice_platform_repository_review_subjects'::regclass,'allrice_platform_repository_reviews'::regclass) and c.conkey=array[(select attnum from pg_attribute where attrelid=c.conrelid and attname='reviewer_run_id')])`;
      const review = rows.filter((r) =>
        r.relation.includes('platform_repository'),
      );
      expect(review).toHaveLength(2);
      expect(review.every((r) => r.target.endsWith('allrice_runs'))).toBe(true);
      expect(
        rows.filter((r) => !r.relation.includes('platform_repository')),
      ).toHaveLength(0);
    });

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
      const development = (args: unknown, requestId = randomUUID()) =>
        executeRepositoryReview(
          {
            context: execution.context,
            worker: lease,
            requestId,
            arguments: args,
          },
          runtimeFixtureStorage(f.db),
          f.db,
        );
      const allowed = () =>
        f.db.begin(async (tx) => {
          const [row] = await tx<
            JobRow[]
          >`select * from allrice_jobs where id=${lease.jobId}`;
          return repositoryReviewCompletionAllowed(tx, row!, false);
        });
      return { ...s, review, lease, execution, development, allowed };
    }

    it.each(['worker-returned', 'complete', 'fail', 'maintenance'] as const)(
      'revoked receipt drain preserves exact receipts and failure through %s',
      async (ending) => {
        const s = await start(await setup());
        const progressInput = { context: s.execution.context, worker: s.lease };
        const progress = createTaskProgressRuntime(progressInput, f.db);
        const call = {
          nativeSessionId: randomUUID(),
          callId: randomUUID(),
          kind: 'tool',
          name: 'platform_repository_review',
          argumentsDigest: 'sha256:' + 'a'.repeat(64),
        };
        const receipt = {
          action: 'finish',
          nativeSessionId: call.nativeSessionId,
          callId: call.callId,
          kind: call.kind,
          outcome: 'error',
          resultDigest: 'sha256:' + 'b'.repeat(64),
        };
        await progress({ action: 'start', ...call });
        await f.db`update allrice_employee_assignments set active=false where id=(select employee_assignment_id from allrice_employee_runs where run_id=${s.review.runId})`;
        const beat = () =>
          heartbeatJob(
            s.lease.workerId,
            s.lease.jobId,
            s.lease.leaseToken,
            300000,
          );
        expect(await beat()).toMatchObject({ active: false, canceled: false });
        const [first] =
          await f.db`select * from allrice_jobs where id=${s.lease.jobId}`;
        expect(first).toMatchObject({
          status: 'running',
          worker_id: s.lease.workerId,
          lease_token: s.lease.leaseToken,
          drain_reason: 'cancel',
          cancel_reason: 'platform_technical_auth_revoked',
          drain_deadline_at: expect.any(Date),
        });
        for (const kind of ['model', 'tool'])
          await expect(
            progress({ action: 'start', ...call, kind, callId: randomUUID() }),
          ).rejects.toThrow('task_progress_lease_lost');
        await expect(
          progress({ ...receipt, callId: randomUUID() }),
        ).rejects.toThrow('task_progress_call_missing');
        for (const worker of [
          { ...s.lease, workerId: randomUUID() },
          { ...s.lease, leaseToken: randomUUID() },
        ])
          await expect(
            createTaskProgressRuntime(
              { ...progressInput, worker },
              f.db,
            )(receipt),
          ).rejects.toThrow('task_progress_lease_lost');
        // A later user cancel and elapsed task clock must not rewrite the
        // first persisted technical stop, move its deadline, or grant retry.
        await cancelPlatformRepositoryReview(s.admin, s.review.id);
        await f.db`update allrice_task_clocks set phase='active',active_ms=(policy->>'timeoutMs')::double precision+1,changed_at=clock_timestamp() where run_id=${s.review.runId}`;
        await f.db.begin((tx) => refreshTaskClock(tx, s.review.runId));
        expect(await beat()).toMatchObject({
          active: false,
          canceled: false,
          draining: true,
        });
        const [again] =
          await f.db`select * from allrice_jobs where id=${s.lease.jobId}`;
        expect(again!.cancel_reason).toBe(first!.cancel_reason);
        expect(again!.drain_deadline_at).toEqual(first!.drain_deadline_at);
        expect(again!.lease_expires_at.getTime()).toBeLessThanOrEqual(
          first!.drain_deadline_at.getTime(),
        );
        if (ending === 'maintenance') {
          await f.db`update allrice_jobs set drain_deadline_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '1 second' where id=${s.lease.jobId}`;
          await expect(progress(receipt)).rejects.toThrow(
            'task_progress_lease_lost',
          );
          await expect(beat()).rejects.toThrow('lease_lost');
          await queue.maintainQueue();
        } else {
          await progress(receipt);
          if (ending === 'worker-returned') await queue.finishJobDrain(s.lease);
          else if (ending === 'complete')
            await completeJob({ ...s.lease, result: { answer: 'late' } });
          else
            await failJob({
              ...s.lease,
              code: 'LATE_HANDLER_FAILURE',
              message: 'synthetic',
              retryable: true,
            });
        }
        const [final] =
          await f.db`select status,last_error_code,worker_id,lease_token from allrice_jobs where id=${s.lease.jobId}`;
        expect(final).toEqual({
          status: 'failed',
          last_error_code: 'PLATFORM_TECHNICAL_AUTH_REVOKED',
          worker_id: null,
          lease_token: null,
        });
        const [stored] =
          await f.db`select finished_at from allrice_task_calls where run_id=${s.review.runId} and call_id=${call.callId}`;
        expect(stored!.finished_at).toEqual(
          ending === 'maintenance' ? null : expect.any(Date),
        );
        const events =
          await f.db`select event_type,payload from allrice_run_events where run_id=${s.review.runId} and event_type in ('run.failed','run.canceled','run.succeeded')`;
        expect(events).toEqual([
          {
            event_type: 'run.failed',
            payload: {
              code: 'PLATFORM_TECHNICAL_AUTH_REVOKED',
              drainDisposition:
                ending === 'maintenance'
                  ? 'receipt_window_closed'
                  : 'worker_returned',
            },
          },
        ]);
      },
    );

    it.each(['progress finish', 'worker-returned'] as const)(
      'revoked receipt drain rolls back %s after a late lock crosses its cutoff',
      async (ending) => {
        const s = await start(await setup());
        const progress = createTaskProgressRuntime(
          { context: s.execution.context, worker: s.lease },
          f.db,
        );
        const call = {
          nativeSessionId: randomUUID(),
          callId: randomUUID(),
          kind: 'model',
        };
        await progress({ action: 'start', ...call });
        await f.db`update allrice_employee_assignments set active=false where id=(select employee_assignment_id from allrice_employee_runs where run_id=${s.review.runId})`;
        expect(
          await heartbeatJob(
            s.lease.workerId,
            s.lease.jobId,
            s.lease.leaseToken,
            300000,
          ),
        ).toMatchObject({ active: false, canceled: false, draining: true });
        // Shorten only this isolated persisted window; do not change the real
        // heartbeat or the production 30s drain. Neither cutoff moves later.
        await f.db`update allrice_jobs j set drain_deadline_at=cutoff.deadline,lease_expires_at=cutoff.deadline
          from (select clock_timestamp()+interval '3 seconds' deadline) cutoff where j.id=${s.lease.jobId}`;
        const snapshot = async () => {
          const [row] = await f.db`
            select j.status,j.worker_id,j.lease_token,j.lease_expires_at,j.drain_deadline_at,
              j.last_error_code,j.completed_at,r.state as run_state,e.status as employee_status,
              m.status as message_status,c.finished_at,c.result_digest,c.outcome,
              t.phase as clock_phase,t.changed_at as clock_changed_at
            from allrice_jobs j join allrice_runs r on r.id=j.run_id
            join allrice_employee_runs e on e.run_id=r.id
            join allrice_messages m on m.id=e.assistant_message_id
            join allrice_task_clocks t on t.run_id=r.id
            join allrice_task_calls c on c.run_id=r.id and c.call_id=${call.callId}
            where j.id=${s.lease.jobId}`;
          return row!;
        };
        const before = await snapshot();
        const held = readPathSignal<number>(),
          release = readPathSignal();
        const blocker = f.db.begin(async (tx) => {
          const [backend] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() pid`;
          if (ending === 'progress finish')
            await tx`select call_id from allrice_task_calls where run_id=${s.review.runId} and call_id=${call.callId} for update`;
          else
            await tx`select id from allrice_messages where id=(select assistant_message_id from allrice_employee_runs where run_id=${s.review.runId}) for update`;
          held.resolve(backend!.pid);
          await release.promise;
        });
        void blocker.catch(held.reject);
        const blockerPid = await held.promise;
        const work = (
          ending === 'progress finish'
            ? progress({
                action: 'finish',
                ...call,
                outcome: 'error',
                resultDigest: 'sha256:' + 'b'.repeat(64),
              })
            : queue.finishJobDrain(s.lease)
        ).then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({
            value: null,
            error: closeOrderingError(error),
          }),
        );
        try {
          // This actual waiting SQL occurs after the original lease check.
          // Its blocker PID proves the interleaving, without a mocked result.
          let waiting: { query: string; now: Date } | undefined;
          await expect
            .poll(
              async () => {
                const [row] = await f.db<{ query: string; now: Date }[]>`
              select query,clock_timestamp() as now from pg_stat_activity
              where ${blockerPid}=any(pg_blocking_pids(pid))`;
                waiting = row;
                return row;
              },
              { timeout: 2000, interval: 20 },
            )
            .toMatchObject({
              query: expect.stringContaining(
                ending === 'progress finish'
                  ? 'from allrice_task_calls'
                  : 'update allrice_messages',
              ),
            });
          // Read DB time independently while the late statement is blocked.
          const [at] = await f.db<
            { now: Date }[]
          >`select clock_timestamp() now`;
          expect(at!.now.getTime()).toBeLessThan(
            before.drain_deadline_at.getTime(),
          );
          await f.db`select pg_sleep_until(${before.drain_deadline_at}::timestamptz + interval '20 milliseconds')`;
          release.resolve();
          await blocker;
          const result = await work,
            after = await snapshot();
          const eventsBefore =
            await f.db`select event_type from allrice_run_events where run_id=${s.review.runId} and event_type in ('run.failed','run.canceled','run.succeeded')`;
          await queue.maintainQueue();
          const final = await snapshot();
          const events =
            await f.db`select event_type,payload from allrice_run_events where run_id=${s.review.runId} and event_type in ('run.failed','run.canceled','run.succeeded')`;
          console.info(
            '[revoked-receipt-deadline]',
            JSON.stringify({
              ending,
              before,
              blockedAt: at!.now,
              waiting,
              result,
              after,
              eventsBefore,
              final,
              events,
            }),
          );
          expect(result).toMatchObject({
            error: {
              message:
                ending === 'progress finish'
                  ? 'task_progress_lease_lost'
                  : 'lease_lost',
            },
          });
          expect(after).toEqual(before);
          expect(eventsBefore).toEqual([]);
          expect(final).toMatchObject({
            status: 'failed',
            last_error_code: 'PLATFORM_TECHNICAL_AUTH_REVOKED',
            worker_id: null,
            lease_token: null,
            finished_at: null,
          });
          expect(events).toEqual([
            {
              event_type: 'run.failed',
              payload: {
                code: 'PLATFORM_TECHNICAL_AUTH_REVOKED',
                drainDisposition: 'receipt_window_closed',
              },
            },
          ]);
        } finally {
          release.resolve();
          await blocker;
          await work;
        }
      },
    );

    it.each(['cancel', 'timeout', 'reserved-reason'] as const)(
      'revoked receipt drain preserves an earlier %s stop',
      async (firstStop) => {
        const s = await start(await setup());
        if (firstStop === 'cancel')
          await cancelPlatformRepositoryReview(s.admin, s.review.id);
        else if (firstStop === 'reserved-reason')
          await queue.cancelRun(
            s.internal,
            s.internal.workspaceId!,
            s.review.runId,
            {
              reason: 'platform_technical_auth_revoked',
            },
          );
        else {
          await f.db`update allrice_task_clocks set phase='active',active_ms=(policy->>'timeoutMs')::double precision+1,changed_at=clock_timestamp() where run_id=${s.review.runId}`;
          await f.db.begin((tx) => refreshTaskClock(tx, s.review.runId));
        }
        const beat = () =>
          heartbeatJob(
            s.lease.workerId,
            s.lease.jobId,
            s.lease.leaseToken,
            300000,
          );
        expect(await beat()).toMatchObject({
          active: false,
          canceled: firstStop !== 'timeout',
          draining: true,
        });
        const [first] =
          await f.db`select cancel_reason,drain_reason,drain_deadline_at from allrice_jobs where id=${s.lease.jobId}`;
        await f.db`update allrice_employee_assignments set active=false where id=(select employee_assignment_id from allrice_employee_runs where run_id=${s.review.runId})`;
        await beat();
        const [later] =
          await f.db`select cancel_reason,drain_reason,drain_deadline_at from allrice_jobs where id=${s.lease.jobId}`;
        expect(later).toEqual(first);
        await queue.finishJobDrain(s.lease);
        const [final] =
          await f.db`select status,last_error_code from allrice_jobs where id=${s.lease.jobId}`;
        expect(final).toEqual(
          firstStop !== 'timeout'
            ? { status: 'canceled', last_error_code: null }
            : { status: 'failed', last_error_code: 'JOB_TIMEOUT' },
        );
      },
    );
    async function opinion(
      s: Awaited<ReturnType<typeof start>>,
      verdict: 'accept' | 'revise' = 'accept',
    ) {
      const seed = (await s.development({ action: 'inspect' })) as {
        candidate: RepositoryReviewArtifactRef;
        evidence: unknown;
        material: RepositoryReviewMaterial;
      };
      expect(seed.material.authorRunIds).not.toContain(s.review.runId);
      const review = (await s.development({
        action: 'review',
        candidate: seed.candidate,
        evidence: seed.evidence,
        verdict,
        summary: 'Synthetic test opinion, not real model review',
      })) as { id: string; artifact: RepositoryReviewArtifactRef };
      return { seed, review };
    }

    it('heartbeat holds Job while the native review tool contends: one transaction, no deadlock or retry', async () => {
      const s = await start(await setup());
      const heartbeatAtCredential = readPathSignal();
      const toolFirstLock = readPathSignal<number>();
      let interleaved = false;
      const beat = reviewLockConnection(
        f.db,
        async ({ sql, execute, tx, pid }) => {
          if (!interleaved && sql.includes('pg_advisory_xact_lock(hashtext(')) {
            heartbeatAtCredential.resolve();
            const toolPid = await toolFirstLock.promise;
            expect(toolPid).not.toBe(pid);
            // This is a bounded test barrier on the two connections just started,
            // not a resource wait. Prove a real PostgreSQL row-lock conflict.
            await vi.waitFor(
              async () => {
                const [wait] = await tx<{ blockers: number[] }[]>`
              select pg_blocking_pids(${toolPid}) as blockers`;
                expect(wait!.blockers).toContain(pid);
              },
              { timeout: 2000, interval: 10 },
            );
            interleaved = true;
          }
          return execute();
        },
      );
      let first = true;
      const tool = reviewLockConnection(f.db, async ({ sql, execute, pid }) => {
        // In the correct order this first lock waits for heartbeat's Job.
        // With the regression, the tool first acquires the credential fence:
        // heartbeat then asks for that fence while the tool waits for its Job.
        if (
          first &&
          sql.includes('allrice_jobs') &&
          sql.includes('for share')
        ) {
          first = false;
          toolFirstLock.resolve(pid);
        } else if (first && sql.includes('pg_advisory_xact_lock(hashtext(')) {
          const value = await execute();
          first = false;
          toolFirstLock.resolve(pid);
          return value;
        }
        return execute();
      });
      vi.mocked(client.getDatabase).mockReturnValue(beat.db);
      const heartbeat = heartbeatJob(
        s.lease.workerId,
        s.lease.jobId,
        s.lease.leaseToken,
        300000,
      );
      void heartbeat.catch((error: unknown) =>
        heartbeatAtCredential.reject(error),
      );
      const called = heartbeatAtCredential.promise.then(() =>
        executeRepositoryReview(
          {
            context: s.execution.context,
            worker: s.lease,
            requestId: randomUUID(),
            arguments: { action: 'inspect' },
          },
          runtimeFixtureStorage(f.db),
          tool.db,
        ),
      );
      void called.catch((error: unknown) => toolFirstLock.reject(error));
      try {
        const result = await Promise.allSettled([heartbeat, called]);
        expect(
          result.map((r) => r.status),
          JSON.stringify(result),
        ).toEqual(['fulfilled', 'fulfilled']);
        expect(await heartbeat).toMatchObject({
          active: true,
          canceled: false,
        });
        expect(await called).toHaveProperty('candidate.artifactId');
        expect(interleaved).toBe(true);
        expect(beat.trace.transactions).toBe(1);
        const [job] =
          await f.db`select status,attempt from allrice_jobs where id=${s.review.jobId}`;
        expect(job).toMatchObject({ status: 'running', attempt: 1 });
      } finally {
        vi.mocked(client.getDatabase).mockReturnValue(f.db);
      }
    }, 30000);

    it.each(['lease', 'login', 'assignment', 'worker'] as const)(
      'review tool rechecks %s authority after its Job lock wait',
      async (change) => {
        const s = await start(await setup());
        const held = readPathSignal<number>(),
          attempted = readPathSignal<number>();
        let first = true;
        const tool = reviewLockConnection(
          f.db,
          async ({ sql, execute, pid }) => {
            if (
              first &&
              sql.includes('allrice_jobs') &&
              sql.includes('for share')
            ) {
              first = false;
              attempted.resolve(pid);
            }
            return execute();
          },
        );
        const holder = f.db.begin(async (tx) => {
          await tx`select id from allrice_jobs where id=${s.review.jobId} for update`;
          const [backend] = await tx<
            { pid: number }[]
          >`select pg_backend_pid() as pid`;
          held.resolve(backend!.pid);
          const toolPid = await attempted.promise;
          expect(toolPid).not.toBe(backend!.pid);
          await vi.waitFor(
            async () => {
              const [wait] = await tx<
                { blockers: number[] }[]
              >`select pg_blocking_pids(${toolPid}) as blockers`;
              expect(wait!.blockers).toContain(backend!.pid);
            },
            { timeout: 2000, interval: 10 },
          );
          if (change === 'lease')
            await tx`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 millisecond' where id=${s.review.jobId}`;
          else if (change === 'login')
            await tx`update allrice_sessions set revoked_at=clock_timestamp() where id=${s.admin.sessionId!}`;
          else if (change === 'assignment')
            await tx`update allrice_employee_assignments set active=false where id=(select employee_assignment_id from allrice_employee_runs where run_id=${s.review.runId})`;
          else
            await tx`update allrice_jobs set worker_id=${randomUUID()},lease_token=${randomUUID()} where id=${s.review.jobId}`;
        });
        void holder.catch((error: unknown) => held.reject(error));
        const called = held.promise.then(() =>
          executeRepositoryReview(
            {
              context: s.execution.context,
              worker: s.lease,
              requestId: randomUUID(),
              arguments: { action: 'inspect' },
            },
            runtimeFixtureStorage(f.db),
            tool.db,
          ),
        );
        void called.catch((error: unknown) => attempted.reject(error));
        const results = await Promise.allSettled([holder, called]);
        expect(results[0]!.status, JSON.stringify(results)).toBe('fulfilled');
        expect(results[1]!.status, JSON.stringify(results)).toBe('rejected');
        await expect(called).rejects.toMatchObject(
          change === 'lease'
            ? { code: 'authorization_denied' }
            : { message: 'repository_review_forbidden' },
        );
        expect(tool.trace.transactions).toBe(1);
        expect(
          await f.db`select version_id from allrice_workbench_artifacts where run_id=${s.review.runId}`,
        ).toHaveLength(0);
      },
      30000,
    );

    async function supersedeArtifact(artifactId: string) {
      // A newer immutable version is a reachable invalidation. Do not mutate
      // ready immutable objects or disable the production provenance triggers.
      await f.db.begin(async (tx) => {
        const objectId = randomUUID(),
          versionId = randomUUID();
        await tx`insert into allrice_storage_objects
          select (jsonb_populate_record(null::allrice_storage_objects,to_jsonb(o)||jsonb_build_object('id',${objectId}::text,'object_key',o.object_key||'-superseded'))).*
          from allrice_storage_objects o join allrice_deliverable_versions v on v.object_id=o.id where v.id=${artifactId}`;
        await tx`insert into allrice_deliverable_versions
          select (jsonb_populate_record(null::allrice_deliverable_versions,to_jsonb(v)||jsonb_build_object('id',${versionId}::text,'object_id',${objectId}::text,'version',v.version+1,'parent_version_id',v.id))).*
          from allrice_deliverable_versions v where v.id=${artifactId}`;
      });
    }

    async function completedReview() {
      return completeReview(await start(await setup()));
    }
    async function readyReview(s: Awaited<ReturnType<typeof start>>) {
      const o = await opinion(s);
      await s.development({
        action: 'deliver',
        candidate: o.seed.candidate,
        reviewId: o.review.id,
      });
      expect(await s.allowed()).toBe(true);
      await recordRepositoryReviewRemote(
        s.lease,
        'postflight',
        s.data.publication.ci,
        s.data.publication.ci_evidence,
      );
      return { ...s, o };
    }
    async function completeReview(input: Awaited<ReturnType<typeof start>>) {
      const s = await readyReview(input);
      await completeJob({
        ...s.lease,
        result: { syntheticProtocolOnly: true },
      });
      await f.db`update allrice_jobs set timeout_at=created_at+interval '1 millisecond' where id=${s.lease.jobId}`;
      return s;
    }
    async function republishReviewEmployee() {
      const [revision] = await f.db`
        select r.definition from allrice_platform_employee_revisions r
        join allrice_platform_employees e on e.current_published_revision_id=r.id
        where e.id=${platformEmployeeId}`;
      await savePlatformEmployeeDraft(platformEmployeeId, {
        definition: PlatformEmployeeDefinitionSchema.parse(
          revision!.definition,
        ),
      });
      const publication = await publishPlatformEmployee(platformEmployeeId, {
        scope: 'assigned',
      });
      expect(publication.errors).toEqual([]);
      expect(publication.valid).toBe(true);
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
    it('MET-210 populated repository review/merge panels and configured credential take no row locks', async () => {
      const s = await completedReview();
      for (const kind of ['review', 'merge', 'credential'] as const) {
        const probe = createReadPathProbe(f.db);
        vi.spyOn(client, 'getDatabase').mockReturnValue(probe.db);
        try {
          if (kind === 'review') {
            const panel = await getPlatformRepositoryReviewPanel(
              s.admin,
              s.data.publication.id,
              1,
            );
            expect(panel.reviews.some((r) => r.id === s.review.id)).toBe(true);
            expect(panel.subjectDigest).toBeTypeOf('string');
          } else if (kind === 'merge') {
            const panel = await getPlatformRepositoryMergePanel(
              s.admin,
              s.data.publication.id,
              1,
            );
            expect(panel.reviewSubjectId).toBe(s.review.id);
            expect(panel.subjectDigest).toBeTypeOf('string');
          } else {
            const credential = await probe.db.begin((tx) =>
              getPlatformRepositoryCredential(s.admin, tx),
            );
            expect(credential).toMatchObject({
              revision: 1,
              state: 'configured',
            });
          }
          probe.expectNoRowLocks();
        } finally {
          vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
        }
      }
    }, 30_000);
    it('MET-210 merge creation still locks the current login and publication against revocation', async () => {
      const s = await completedReview();
      let checked = false;
      const probe = createReadPathProbe(f.db, {
        beforeCommit: async (_tx, index) => {
          // Context discovery can also open a read transaction. Check the actual
          // merge write, identified by its assigned PostgreSQL transaction id.
          const [row] = await _tx<
            { xid: string | null }[]
          >`select pg_current_xact_id_if_assigned()::text as xid`;
          if (!row!.xid || checked) return;
          await expectReadPathRowLocked(
            f.db,
            'allrice_sessions',
            s.admin.sessionId!,
          );
          await expectReadPathRowLocked(
            f.db,
            'allrice_platform_repository_publications',
            s.data.publication.id,
          );
          checked = true;
          expect(index).toBeGreaterThanOrEqual(0);
        },
      });
      let created:
        Awaited<ReturnType<typeof createPlatformRepositoryMerge>> | undefined;
      vi.spyOn(client, 'getDatabase').mockReturnValue(probe.db);
      try {
        created = await createPlatformRepositoryMerge(s.admin, mergeRequest(s));
      } finally {
        vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
        if (created)
          await cancelPlatformRepositoryMerge(
            s.admin,
            created.id,
            created.actions[0]!.id,
          );
      }
      expect(checked).toBe(true);
      // Cancellation is requested here and settled by the Worker; a job with
      // the request recorded is never claimed by the next case.
      expect(
        await f.db`select id from allrice_jobs where run_id=${created!.actions[0]!.runId} and status in ('queued','claimed','running') and cancel_requested_at is null`,
      ).toHaveLength(0);
    }, 30_000);
    it('reads historical merge status from the subject ledger without accepting a legacy report proof', async () => {
      const s = await completedReview();
      const proof = await f.db.begin((tx) =>
        readCompletedRepositoryReview(tx, s.internal, s.review.id),
      );
      const legacy = {
        ...proof,
        version: 1,
        reportDeliveryId: randomUUID(),
        adoptedSeq: 2,
      };
      expect(RepositoryCompletedReviewSchema.safeParse(legacy).success).toBe(
        false,
      );
      const id = randomUUID();
      await f.db`insert into allrice_platform_repository_merges(id,publication_id,review_subject_id,owner_id,organization_id,workspace_id,review,review_digest)
        values(${id},${s.data.publication.id},${s.review.id},${s.admin.actor.id},${s.internal.organizationId},${s.internal.workspaceId!},${f.db.json(legacy)},${technicalDigest(legacy)})`;
      const view = await getPlatformRepositoryMerge(s.admin, id);
      expect(view.subjectDigest).toBe(s.o.seed.material.subjectDigest);
      expect(view.actions).toEqual([]);
      expect(view.receipt).toBeNull();
    });

    it('consumes a completed expired review, binds one concurrent request and confirms exact main merge without claiming Dev', async () => {
      const s = await completedReview();
      const proof = await f.db.begin((tx) =>
        readCompletedRepositoryReview(tx, s.internal, s.review.id),
      );
      expect(proof.reviewerRunId).toBe(s.review.runId);
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
    it('rejects completed evidence after Job cancellation or superseded evidence, and rejects raw merge job admission', async () => {
      const s = await completedReview();
      await expect(
        enqueueRun(s.internal, {
          type: 'allrice.platform.repository.merge',
          workspaceId: s.internal.workspaceId,
          input: {},
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      await f.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${s.review.jobId}`;
      await expect(
        createPlatformRepositoryMerge(s.admin, mergeRequest(s)),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
      const second = await completedReview();
      await supersedeArtifact(second.o.review.artifact.artifactId);
      await expect(
        createPlatformRepositoryMerge(second.admin, mergeRequest(second)),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }, 30000);

    it('retains finished Job review facts across old login/PAT expiry while requiring new current credentials', async () => {
      const s = await completedReview();
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
      expect(proof.reviewerRunId).toBe(s.review.runId);
      expect(proof).not.toHaveProperty('reportDeliveryId');
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

    it.each(['proof', 'completion'] as const)(
      'real employee disable follows an in-flight %s and permanently revokes the succeeded result',
      async (first) => {
        const s =
          first === 'proof'
            ? await completedReview()
            : await readyReview(await start(await setup()));
        const held = readPathSignal<{
            tx: RuntimeLedgerTransaction;
            pid: number;
          }>(),
          release = readPathSignal(),
          revokerStarted = readPathSignal<number>(),
          lockBusy = readPathSignal();
        const holder = createReadPathProbe(f.db, {
          beforeCommit: async (tx) => {
            const [backend] = await tx<{ pid: number }[]>`
              select pg_backend_pid() as pid`;
            held.resolve({ tx, pid: backend!.pid });
            await release.promise;
          },
        });
        const revoker = reviewLockConnection(f.db, async ({ execute, pid }) => {
          revokerStarted.resolve(pid);
          try {
            return await execute();
          } catch (error) {
            if ((error as { code?: string }).code === '55P03')
              lockBusy.resolve();
            throw error;
          }
        });
        vi.mocked(client.getDatabase).mockReturnValue(holder.db);
        const earlier =
          first === 'proof'
            ? holder.db.begin((tx) =>
                readCompletedRepositoryReview(tx, s.internal, s.review.id),
              )
            : completeJob({
                ...s.lease,
                result: { syntheticProtocolOnly: true },
              });
        void earlier.catch((error: unknown) => held.reject(error));
        let disabled: ReturnType<typeof disablePlatformEmployee> | undefined;
        try {
          const owner = await held.promise;
          vi.mocked(client.getDatabase).mockReturnValue(revoker.db);
          disabled = disablePlatformEmployee(platformEmployeeId, {
            reason: 'Revoke the completed reviewer authority',
          });
          void disabled.catch((error: unknown) => {
            revokerStarted.reject(error);
            lockBusy.reject(error);
          });
          const revokerPid = await revokerStarted.promise;
          expect(revokerPid).not.toBe(owner.pid);
          if (first === 'proof') {
            // Completed proof holds Job SHARE. Existing NOWAIT access
            // cancellation rolls back and retries the entire disable.
            await lockBusy.promise;
          } else {
            // Live completion also holds assignment/deployment authority.
            // Prove disable waits on that transaction, then sees success.
            await vi.waitFor(
              async () => {
                const [wait] = await owner.tx<{ blockers: number[] }[]>`
                  select pg_blocking_pids(${revokerPid}) as blockers`;
                expect(wait!.blockers).toContain(owner.pid);
              },
              { timeout: 2000, interval: 10 },
            );
          }
          release.resolve();
          await Promise.all([earlier, disabled]);
          if (first === 'proof') {
            expect(await earlier).toHaveProperty(
              'reviewerRunId',
              s.review.runId,
            );
            expect(revoker.trace.transactions).toBeGreaterThan(1);
          } else expect(revoker.trace.transactions).toBe(1);
          const [history] = await f.db`
            select j.status,r.state,j.cancel_requested_at,j.cancel_reason
            from allrice_jobs j join allrice_runs r on r.id=j.run_id
            where j.id=${s.review.jobId}`;
          expect(history).toMatchObject({
            status: 'succeeded',
            state: 'succeeded',
            cancel_reason: 'Revoke the completed reviewer authority',
          });
          expect(history!.cancel_requested_at).toBeInstanceOf(Date);
          const [audit] = await f.db`
            select metadata from allrice_audit_events
            where resource_id=${s.review.runId} and action='run.cancel.request'`;
          expect(audit!.metadata).toMatchObject({
            status: 'succeeded',
            resultAuthorityRevoked: true,
          });
          await expect(
            f.db.begin((tx) =>
              readCompletedRepositoryReview(tx, s.internal, s.review.id),
            ),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
        } finally {
          release.resolve();
          await Promise.allSettled([earlier, disabled]);
          vi.mocked(client.getDatabase).mockReturnValue(f.db);
          await republishReviewEmployee();
        }
        if (first === 'proof') {
          // Restore the private deployment through the same publisher used by
          // ensureQualityEmployee; generic tenant assignment enables inheritance.
          type Revision = Parameters<
            typeof materializePlatformEmployeeRevision
          >[1]['revision'];
          const [revision] = await f.db<Revision[]>`
            select r.* from allrice_platform_employee_revisions r
            join allrice_platform_employees e on e.current_published_revision_id=r.id
            where e.id=${platformEmployeeId}`;
          await f.db.begin((tx) =>
            materializePlatformEmployeeRevision(tx, {
              employeeId: platformEmployeeId,
              revision: revision!,
              definition: PlatformEmployeeDefinitionSchema.parse(
                revision!.definition,
              ),
              workspaceIds: [s.internal.workspaceId!],
              actorLabel: s.admin.actor.id,
              inheritByDefault: false,
              preserveCurrentPolicy: true,
            }),
          );
          await ensureQualityEmployee(s.admin);
          const [active] = await f.db`
            select a.active,d.active deployment_active,e.status
            from allrice_employee_runs r
            join allrice_employee_assignments a on a.id=r.employee_assignment_id
            join allrice_platform_employee_tenant_assignments d on d.tenant_employee_id=a.employee_id and d.workspace_id=a.workspace_id
            join allrice_employees e on e.id=a.employee_id where r.run_id=${s.review.runId}`;
          expect(active).toMatchObject({
            active: true,
            deployment_active: true,
            status: 'active',
          });
          await expect(
            f.db.begin((tx) =>
              readCompletedRepositoryReview(tx, s.internal, s.review.id),
            ),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          await expect(
            createPlatformRepositoryMerge(s.admin, mergeRequest(s)),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          expect(
            (await getPlatformRepositoryReview(s.admin, s.review.id)).status,
          ).toBe('succeeded');
          const panel = await getPlatformRepositoryReviewPanel(
            s.admin,
            s.data.publication.id,
            1,
          );
          expect(panel).toMatchObject({
            canStart: true,
            subjectDigest: s.review.subjectDigest,
            readiness: { state: 'unknown', reasons: ['authority_revoked'] },
          });
          expect(panel.reviews[0]).toMatchObject({
            id: s.review.id,
            status: 'succeeded',
            verdict: 'accept',
          });
          const nextRequestId = randomUUID(),
            next = await s.create(nextRequestId);
          expect(next.subjectDigest).toBe(s.review.subjectDigest);
          expect(next.runId).not.toBe(s.review.runId);
          expect(next.id).not.toBe(s.review.id);
          expect((await s.create(nextRequestId)).id).toBe(next.id);
          await expect(s.create()).rejects.toMatchObject({ code: 'conflict' });
          const completed = await completeReview(await start(s, next));
          const newProof = await f.db.begin((tx) =>
            readCompletedRepositoryReview(tx, s.internal, completed.review.id),
          );
          expect(newProof.reviewerRunId).toBe(next.runId);
          await expect(
            f.db.begin((tx) =>
              readCompletedRepositoryReview(tx, s.internal, s.review.id),
            ),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          await expect(
            getPlatformRepositoryReviewPanel(s.admin, s.data.publication.id, 1),
          ).resolves.toMatchObject({
            canStart: false,
            readiness: { state: 'accepted' },
          });
          await expect(s.create()).rejects.toMatchObject({ code: 'conflict' });
        }
      },
      30000,
    );

    it.each(['proof', 'completion'] as const)(
      'a %s waiting for real employee disable observes the committed revocation',
      async (later) => {
        const s =
          later === 'proof'
            ? await completedReview()
            : await readyReview(await start(await setup()));
        const held = readPathSignal<{
            tx: RuntimeLedgerTransaction;
            pid: number;
          }>(),
          release = readPathSignal(),
          attempted = readPathSignal<number>();
        const revoker = createReadPathProbe(f.db, {
          beforeCommit: async (tx) => {
            const [backend] = await tx<{ pid: number }[]>`
              select pg_backend_pid() as pid`;
            held.resolve({ tx, pid: backend!.pid });
            await release.promise;
          },
        });
        const consumer = reviewLockConnection(
          f.db,
          async ({ execute, pid }) => {
            // Completion first meets the existing root-creation fence;
            // completed proof first meets Job SHARE. Observe either real wait.
            attempted.resolve(pid);
            return execute();
          },
        );
        vi.mocked(client.getDatabase).mockReturnValue(revoker.db);
        const disabled = disablePlatformEmployee(platformEmployeeId, {
          reason: 'Revoke before proof or completion consumes authority',
        });
        void disabled.catch((error: unknown) => held.reject(error));
        let consumed: Promise<unknown> | undefined;
        try {
          const owner = await held.promise;
          vi.mocked(client.getDatabase).mockReturnValue(consumer.db);
          consumed =
            later === 'proof'
              ? consumer.db.begin((tx) =>
                  readCompletedRepositoryReview(tx, s.internal, s.review.id),
                )
              : completeJob({
                  ...s.lease,
                  result: { syntheticProtocolOnly: true },
                });
          void consumed.catch((error: unknown) => attempted.reject(error));
          const consumerPid = await attempted.promise;
          expect(consumerPid).not.toBe(owner.pid);
          await vi.waitFor(
            async () => {
              const [wait] = await owner.tx<{ blockers: number[] }[]>`
                select pg_blocking_pids(${consumerPid}) as blockers`;
              expect(wait!.blockers).toContain(owner.pid);
            },
            { timeout: 2000, interval: 10 },
          );
          release.resolve();
          await disabled;
          if (later === 'proof')
            await expect(consumed).rejects.toMatchObject({
              code: 'authorization_denied',
            });
          else await consumed;
          const [job] = await f.db`
            select status,cancel_requested_at from allrice_jobs where id=${s.review.jobId}`;
          expect(job!.status).toBe(
            later === 'proof' ? 'succeeded' : 'canceled',
          );
          expect(job!.cancel_requested_at).toBeInstanceOf(Date);
          await expect(
            f.db.begin((tx) =>
              readCompletedRepositoryReview(tx, s.internal, s.review.id),
            ),
          ).rejects.toMatchObject({ code: 'authorization_denied' });
          expect(consumer.trace.transactions).toBe(1);
        } finally {
          release.resolve();
          await Promise.allSettled([disabled, consumed]);
          vi.mocked(client.getDatabase).mockReturnValue(f.db);
          await republishReviewEmployee();
        }
      },
      30000,
    );

    it('requires ordinary Job completion and current artifact facts even when the review opinion is retained', async () => {
      for (const fault of ['artifact', 'job-cancel', 'run-state'] as const) {
        const s = await completedReview();
        if (fault === 'artifact')
          await supersedeArtifact(s.o.review.artifact.artifactId);
        else if (fault === 'job-cancel')
          await f.db`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${s.review.jobId}`;
        else
          await f.db`update allrice_runs set state='failed' where id=${s.review.runId}`;
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
            await f.db`select count(*)::int as n from pg_stat_activity
              where datname=current_database() and application_name=current_schema()
                and wait_event='advisory' and query like '%pg_advisory_xact_lock(hashtextextended%'`;
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

    it('completes independent Job inspect → saved opinion → delivery → canonical completion and private download without assistants', async () => {
      const legacyHistory = await readRetiredExecutionHistory(f.db);
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
      })) as { artifact: RepositoryReviewArtifactRef };
      expect(await s.allowed()).toBe(true);
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
      expect(detail.reviewerRunId).toBe(s.review.runId);
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
      expect(await readRetiredExecutionHistory(f.db)).toEqual(legacyHistory);
    }, 30000);
    it('cancellation of the review Job invalidates delivery and final completion', async () => {
      const s = await start(await setup()),
        o = await opinion(s);
      await s.development({
        action: 'deliver',
        candidate: o.seed.candidate,
        reviewId: o.review.id,
      });
      await cancelPlatformRepositoryReview(s.admin, s.review.id);
      expect(await s.allowed()).toBe(false);
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
      ).toBe('canceled');
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
        s.development({
          action: 'review',
          candidate: o.seed.candidate,
          evidence: o.seed.evidence,
          verdict: 'accept',
          summary: 'replacement',
        }),
      ).rejects.toThrow();
      expect(await s.allowed()).toBe(true);
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
    it('MET-210 a cancel never queues behind the request gate while it waits for the credential fence', async () => {
      const s = await start(await setup());
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
      void gated.catch(() => undefined);
      try {
        await vi.waitFor(
          async () => {
            const [waiting] = await f.db<
              { n: number }[]
            >`select count(*)::int n from pg_locks where locktype='advisory' and not granted`;
            expect(waiting!.n).toBeGreaterThan(0);
          },
          { timeout: 5000, interval: 20 },
        );
        // The job row update a cancellation makes; it would wait for the
        // gate's row lock (and time out) if the gate held one.
        await f.db.begin(async (tx) => {
          await tx`set local lock_timeout = '1s'`;
          await tx`update allrice_jobs set cancel_requested_at=clock_timestamp() where id=${s.review.jobId}`;
        });
      } finally {
        release();
        await holder;
      }
      await expect(gated).rejects.toMatchObject({
        code: 'authorization_denied',
      });
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
