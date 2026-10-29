/** Upgrade-only driver. The keeper copies this module into the exact old
 * checkout; its imports, contracts, admission, Worker and Host all resolve there.
 * The reusable harness below has no legacy API calls and also runs after upgrade.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RequestContext, StoragePort } from '@allrice/contracts';
import { expect, vi } from 'vitest';
import * as Client from '../../../../packages/database/src/core/client.ts';
import { createRunAuthorityFixture } from '../../../../packages/database/src/run-authority.fixture.ts';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import {
  authenticateSession,
  createSession,
} from '../../../../packages/database/src/identity.ts';
import {
  createAssignedChatSession,
  sendChatMessage,
} from '../../../../packages/database/src/workspace/service.ts';
import * as ModelPool from '../../../../packages/database/src/providers/model-pool.ts';
import {
  appendJobEvent,
  cancelRun,
  claimNextJob,
  completeJob,
  finishJobDrain,
  startClaimedJob,
} from '../../../../packages/database/src/execution/queue.ts';
import { publishWorkbenchArtifact } from '../../../../packages/database/src/artifact-review.ts';
import {
  finalDeliveryFactsDigest,
  finalDeliveryTextDigest,
} from '../../../../packages/database/src/final-delivery-commit.ts';
import { readDeliverySnapshot } from '../../../../packages/database/src/run-delivery.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.ts';
import { prepareExecutionIsolation } from '../../src/isolation.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import { normalizeHarnessRunEvent } from '../../src/harness/runtime-contract.ts';
import * as Router from '../../src/harness/router.ts';
import * as NativeArtifact from '../../src/harness/dsh-native-artifact.ts';
import {
  DSH_DISTRIBUTION_CURRENT_GENERATION,
  DSH_DISTRIBUTION_CURRENT_VERSION,
} from '../../src/harness/dsh-distribution.ts';
import {
  beginCheckedFinalDeliveryExecution,
  readCheckedFinalDeliveryForExecution,
} from '../../src/final-delivery/checked-delivery.ts';
import { p24Fixture } from '../p24/fixture.ts';

export interface DeliveryResources {
  db: ReturnType<typeof Client.getDatabase>;
  storage: StoragePort;
  storageRoot: string;
  nativeRoot: string;
}
export interface DeliverySubject {
  context: RequestContext;
  workspaceId: string;
  employeeId: string;
  employeeVersionId: string;
  assignmentId: string;
  sessionId: string;
}
export type PublishedDelivery = Awaited<
  ReturnType<typeof publishWorkbenchArtifact>
>;
export interface OrdinaryDelivery {
  runId: string;
  jobId: string;
  messageIds: string[];
  artifactVersionIds: string[];
  checksums: string[];
  artifact: PublishedDelivery;
  bytesBase64: string;
  runBefore: unknown;
  messagesBefore: unknown;
  versionBefore: unknown;
  bindingBefore: unknown;
  originBefore: unknown;
  nativeJournalDigest: string;
  nativeSessionId: string;
  modelRequests: number;
}
export interface DeliveryCohort extends DeliverySubject {
  kind: 'never-enabled' | 'previously-enabled';
  ordinaryRuns: OrdinaryDelivery[];
  workAutomationBefore: {
    revision: number;
    settings: Record<string, boolean>;
  } | null;
  nativePreferencesBefore: unknown[];
  auditEventIds: string[];
  auditEventsBefore: unknown[];
}
export const deliveryArtifactId = `sha256:${'a'.repeat(64)}`;
const modelName = 'retirement-loopback';
export const sha256 = (bytes: string | Buffer) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const jsonValue = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value));

/** Reuses p24's HTTP responder and the production DSH adapter/Host. The only
 * substitutions are DB ownership, the installed test artifact and model target.
 * Eligibility, native events, proof, storage and completion are never mocked.
 */
export async function createDeliveryHarness(
  resources: DeliveryResources,
  reply: Parameters<typeof p24Fixture>[0],
) {
  const { db, storageRoot, nativeRoot } = resources;
  vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
  vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
  vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
  vi.stubEnv('ALLRICE_STORAGE_ROOT', storageRoot);
  vi.stubEnv(
    'ALLRICE_DSH_PLATFORM_HOME',
    join(nativeRoot, 'unused-platform-home'),
  );
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', deliveryArtifactId);
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', deliveryArtifactId);
  const mocks: { mockRestore(): void }[] = [];
  let model: Awaited<ReturnType<typeof p24Fixture>> | undefined;
  let adapter: DshHarnessAdapter | undefined;
  const cleanups = new Set<() => Promise<void>>();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await adapter?.close();
    } finally {
      try {
        await model?.close();
      } finally {
        try {
          for (const cleanup of cleanups) await cleanup();
        } finally {
          for (const mock of mocks.reverse()) mock.mockRestore();
        }
      }
    }
  };
  try {
    await mkdir(nativeRoot, { recursive: true });
    mocks.push(vi.spyOn(Client, 'getDatabase').mockReturnValue(db));
    model = await p24Fixture(reply);
    const launch = {
      artifactId: deliveryArtifactId,
      generation: DSH_DISTRIBUTION_CURRENT_GENERATION,
      version: DSH_DISTRIBUTION_CURRENT_VERSION,
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
      ],
      profile: resolve(
        import.meta.dirname,
        '../../dsh/allrice-restricted.cordis.yml',
      ),
    };
    mocks.push(
      vi.spyOn(NativeArtifact, 'checkedDshNativeLaunch').mockReturnValue({
        artifactId: deliveryArtifactId,
        profileId: 'restricted',
      }),
    );
    mocks.push(
      vi
        .spyOn(NativeArtifact, 'currentDshNativeLaunch')
        .mockImplementation((profile) => {
          expect(profile).toBe('restricted');
          return launch;
        }),
    );
    adapter = new DshHarnessAdapter({
      runtimeRoot: nativeRoot,
      idleCloseMs: 0,
      requestTimeoutMs: 15000,
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-loopback-only' }),
      },
    });
    mocks.push(
      vi
        .spyOn(Router, 'getHarnessRouter')
        .mockReturnValue(new Router.HarnessRouter([adapter])),
    );
    // As in run-delivery-worker, replace only the selected model before INSERT.
    // The production admission path still freezes the real delivery policy.
    const targets = new Map<
      string,
      { connectionId: string; catalogId: string }
    >();
    const freezeModel = ModelPool.freezeSessionModelSnapshot;
    mocks.push(
      vi
        .spyOn(ModelPool, 'freezeSessionModelSnapshot')
        .mockImplementation(async (input, database) => {
          const target = targets.get(input.workspaceId);
          if (!target) throw Error('retirement_missing_loopback_target');
          const frozen = await freezeModel(input, database);
          const snapshot = {
            ...frozen,
            connectionId: target.connectionId,
            modelCatalogEntryId: target.catalogId,
            provider: 'openai-compatible',
            authMode: 'api_key' as const,
            model: modelName,
            credentialReference: 'test:retirement-loopback',
            baseUrl: model!.baseUrl,
          };
          const sql = database ?? db;
          await sql`update allrice_session_model_snapshots set connection_id=${target.connectionId},model_catalog_entry_id=${target.catalogId},snapshot=${sql.json(snapshot)} where session_id=${input.sessionId}`;
          return snapshot;
        }),
    );
    async function connectSubject(subject: DeliverySubject) {
      await authorizeFixturePlatformAdministrator(db, subject.context.actor.id);
      await db`insert into allrice_model_providers(id,provider_key,name,harness,auth_mode,enabled)
        values(${randomUUID()},'openai-compatible','Retirement loopback','dsh','api_key',true)
        on conflict(provider_key) do update set enabled=true`;
      const [provider] =
        await db`select id from allrice_model_providers where provider_key='openai-compatible'`;
      const connectionId = randomUUID(),
        catalogId = randomUUID();
      await db`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference,base_url,status)
        values(${connectionId},${provider!.id},'platform',${`Retirement loopback ${connectionId}`},'test:retirement-loopback',${model!.baseUrl},'ready')`;
      await db`insert into allrice_model_catalog_entries(id,provider_id,model,display_name,reasoning_efforts,default_reasoning_effort,input_modalities,output_modalities,enabled)
        values(${catalogId},${provider!.id},${modelName},'Retirement loopback','["low"]','low','["text"]','["text"]',true)
        on conflict(provider_id,model) do update set enabled=true`;
      const [catalog] =
        await db`select id from allrice_model_catalog_entries where provider_id=${provider!.id} and model=${modelName}`;
      targets.set(subject.workspaceId, {
        connectionId,
        catalogId: catalog!.id,
      });
      await ModelPool.upsertEmployeeModelPolicy({
        context: subject.context,
        workspaceId: subject.workspaceId,
        employeeId: subject.employeeId,
        policy: {
          connectionId,
          modelCatalogEntryId: catalog!.id,
          reasoningEffort: 'low',
          fallbackPolicy: 'disabled',
          fallbackTargets: [],
          fallbackOn: [],
          runLimits: {
            timeoutMs: 300000,
            maxInputTokens: 100000,
            maxOutputTokens: 4000,
            maxTotalTokens: 150000,
            maxCostCents: 10000,
          },
        },
      });
    }
    async function createSubject(): Promise<DeliverySubject> {
      const identity = await createRunAuthorityFixture(db, {
        configure: false,
        allowedTools: ['workspace.export.create', 'workspace.document.read'],
        runtimePolicy: {
          harness: 'dsh',
          provider: 'openai-compatible',
          model: modelName,
          reasoningEffort: 'low',
          timeoutMs: 300000,
          fallbackModels: [],
          credentialReference: 'test:retirement-loopback',
          baseUrl: model!.baseUrl,
        },
      });
      const login = await createSession(identity.user);
      const context = (await authenticateSession(login.token, {
        organizationId: identity.org,
        workspaceId: identity.workspace,
      }))!;
      // The identity helper's synthetic running Job is not historical success.
      // Stop it through the queue API; all claimed work must be quiescent at READY.
      await cancelRun(context, identity.workspace, identity.rootRunId, {
        reason: 'user_requested',
      });
      await finishJobDrain(identity.worker);
      const subject: DeliverySubject = {
        context,
        workspaceId: identity.workspace,
        employeeId: identity.employee,
        employeeVersionId: identity.version,
        assignmentId: identity.assignment,
        sessionId: '',
      };
      await connectSubject(subject);
      const chat = await createAssignedChatSession(context, {
        workspaceId: identity.workspace,
        employeeAssignmentId: identity.assignment,
        title: 'Retained ordinary monthly report',
      });
      return { ...subject, sessionId: chat.id };
    }
    async function prepare(subject: DeliverySubject, text: string) {
      const sent = await sendChatMessage(
        subject.context,
        subject.workspaceId,
        subject.sessionId,
        { text, clientMessageId: randomUUID(), deliveryMode: 'follow_up' },
      );
      if (!sent.run) throw Error('retirement_run_not_admitted');
      const workerId = randomUUID();
      const job = (await claimNextJob(workerId, 300000))!;
      const [queued] =
        await db`select id from allrice_jobs where run_id=${sent.run.id}`;
      expect(job.id).toBe(queued!.id);
      const workflowLease = {
        workerId,
        jobId: job.id,
        leaseToken: job.lease!.token,
        leaseMs: 300000,
      };
      const execution = (await startClaimedJob(
        workerId,
        job.id,
        workflowLease.leaseToken,
      ))!;
      const isolation = await prepareExecutionIsolation({
        root: join(nativeRoot, 'execution'),
        organizationId: subject.context.organizationId,
        workspaceId: subject.workspaceId,
        ownerId: subject.context.actor.id,
        runId: sent.run.id,
        jobId: job.id,
        attempt: execution.job.attempt,
      });
      cleanups.add(isolation.cleanup);
      const [stored] =
        await db`select execution_snapshot from allrice_employee_runs where run_id=${sent.run.id}`;
      expect(stored!.execution_snapshot.modelSnapshot).toMatchObject({
        provider: 'openai-compatible',
        model: modelName,
      });
      const controller = new AbortController();
      beginCheckedFinalDeliveryExecution(workflowLease);
      return {
        runId: sent.run.id,
        execution,
        workflowLease,
        controller,
        snapshot: stored!.execution_snapshot,
        run: () =>
          executeEmployeeRun({
            execution,
            workflowLease,
            isolation,
            signal: controller.signal,
            onHarnessEvent: async (event) => {
              await appendJobEvent({
                ...workflowLease,
                ...normalizeHarnessRunEvent(event),
              });
            },
          }),
        cleanup: async () => {
          await isolation.cleanup();
          cleanups.delete(isolation.cleanup);
        },
      };
    }
    async function journal() {
      const paths = (await readdir(nativeRoot, { recursive: true }))
        .filter((path) => path.endsWith('.jsonl'))
        .sort();
      return (
        await Promise.all(
          paths.map((path) => readFile(join(nativeRoot, path), 'utf8')),
        )
      ).join('\n');
    }
    return {
      ...resources,
      model,
      adapter,
      createSubject,
      connectSubject,
      prepare,
      journal,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type DeliveryHarness = Awaited<ReturnType<typeof createDeliveryHarness>>;
export type DeliveryTask = Awaited<ReturnType<DeliveryHarness['prepare']>>;

export async function publishDelivery(
  harness: DeliveryHarness,
  subject: DeliverySubject,
  task: DeliveryTask,
  bytes: Buffer,
) {
  return publishWorkbenchArtifact(
    {
      context: task.execution.context,
      sessionId: subject.sessionId,
      callId: randomUUID(),
      kind: 'document',
      fileName: '月报.txt',
      format: 'text',
      mediaType: 'text/plain',
      bytes,
    },
    harness.storage,
    harness.db,
  );
}
export async function readDeliveryBytes(
  resources: DeliveryResources,
  artifact: PublishedDelivery,
) {
  return Buffer.from(
    await new Response(
      await resources.storage.get(artifact.object),
    ).arrayBuffer(),
  );
}
export async function deliveryState(
  db: DeliveryResources['db'],
  runId: string,
) {
  return (
    await db`select j.id job_id,j.status,r.state,r.result,m.content->>'text' text,
    (select count(*)::int from allrice_run_events ev where ev.run_id=r.id and ev.event_type='run.succeeded') successes
    from allrice_jobs j join allrice_runs r on r.id=j.run_id join allrice_employee_runs e on e.run_id=r.id
    join allrice_messages m on m.id=e.assistant_message_id where r.id=${runId}`
  )[0]!;
}
export async function assertDeliveryProof(
  harness: DeliveryHarness,
  subject: DeliverySubject,
  task: DeliveryTask,
  result: Awaited<ReturnType<DeliveryTask['run']>>,
  artifact?: PublishedDelivery,
) {
  const coverage = readCheckedFinalDeliveryForExecution(
    task.workflowLease,
    result,
  );
  expect(coverage.coverage).toBe('checked_native_v1');
  if (coverage.coverage !== 'checked_native_v1')
    throw Error('retirement_missing_checked_proof');
  const facts = await readDeliverySnapshot({
    scope: {
      organizationId: subject.context.organizationId,
      workspaceId: subject.workspaceId,
      projectId: null,
    },
    rootRunId: task.runId,
    worker: {
      ...task.workflowLease,
      attempt: task.execution.job.attempt,
      generation: coverage.proof.generation,
    },
  });
  expect(coverage.proof.candidateDigest).toBe(
    finalDeliveryTextDigest(result.answer),
  );
  expect(coverage.proof.factSetDigest).toBe(finalDeliveryFactsDigest(facts));
  if (artifact)
    expect(facts.artifacts).toContainEqual(
      expect.objectContaining({
        objectId: artifact.object.id,
        versionId: artifact.version.id,
      }),
    );
  const starts =
    await harness.db`select payload from allrice_run_events where run_id=${task.runId} and event_type='turn.started' order by sequence`;
  expect(starts.length).toBeGreaterThan(0);
  expect(
    starts.every(
      (row) => row.payload.threadId === coverage.proof.nativeSessionId,
    ),
  ).toBe(true);
  const replies = (await harness.journal())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter(
      (event) =>
        event.type === 'assistant/message' &&
        event.data.message.id === coverage.proof.publicMessageId,
    );
  expect(replies).toEqual([
    expect.objectContaining({
      seq: coverage.proof.durableSeq,
      data: expect.objectContaining({
        message: expect.objectContaining({
          source: expect.objectContaining({
            provider: 'openai-compatible',
            model: modelName,
          }),
        }),
      }),
    }),
  ]);
  return coverage;
}
export async function completeDelivery(
  task: DeliveryTask,
  result: Awaited<ReturnType<DeliveryTask['run']>>,
) {
  const coverage = readCheckedFinalDeliveryForExecution(
    task.workflowLease,
    result,
  );
  await completeJob({
    ...task.workflowLease,
    result,
    ...(coverage.coverage === 'checked_native_v1'
      ? { checkedDelivery: coverage.checkedDelivery }
      : {}),
  });
}

/** This function is invoked only by the frozen old-checkout Vitest keeper. */
export default async function seed(resources: DeliveryResources) {
  // These old API calls deliberately stay in this driver, never in after code.
  const { updateWorkAutomation } =
    await import('../../../../packages/database/src/work-automation.ts');
  // Do not suppress the old feature globally to manufacture an ordinary Run.
  // The actual old admission sees the saved setting and this employee's tools.
  vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
  let answer = '';
  const harness = await createDeliveryHarness(resources, async () => ({
    text: answer,
  }));
  const cohorts: DeliveryCohort[] = [];
  try {
    for (const kind of ['never-enabled', 'previously-enabled'] as const) {
      const subject = await harness.createSubject();
      if (kind === 'previously-enabled') {
        await updateWorkAutomation(
          subject.context,
          subject.workspaceId,
          { expectedRevision: 0, capability: 'assistants', enabled: true },
          resources.db,
        );
        await updateWorkAutomation(
          subject.context,
          subject.workspaceId,
          { expectedRevision: 1, capability: 'cloud', enabled: false },
          resources.db,
        );
        await updateWorkAutomation(
          subject.context,
          subject.workspaceId,
          { expectedRevision: 2, capability: 'computer', enabled: true },
          resources.db,
        );
      }
      const { db } = resources;
      const settings =
        await db`select revision,settings from allrice_member_work_automation where organization_id=${subject.context.organizationId} and workspace_id=${subject.workspaceId} and user_id=${subject.context.actor.id}`;
      expect(jsonValue(settings)).toEqual(
        kind === 'never-enabled'
          ? []
          : [
              {
                revision: 3,
                settings: { assistants: true, cloud: false, computer: true },
              },
            ],
      );
      const preferences =
        await db`select * from allrice_user_preferences where user_id=${subject.context.actor.id}`;
      expect(preferences).toHaveLength(0);
      const audits =
        await db`select id,action,metadata from allrice_audit_events where actor_id=${subject.context.actor.id} and action='member.work_automation.update' order by metadata->>'revision'`;
      expect(audits).toHaveLength(kind === 'never-enabled' ? 0 : 3);
      const task = await harness.prepare(
        subject,
        '帮我完成这项任务：把本月收支整理成月报文件，把下载链接给我。',
      );
      const bytes = Buffer.from(
        `真实普通月报 ${kind}\n收入 1200，支出 450，结余 750。\n`,
      );
      try {
        const artifact = await publishDelivery(harness, subject, task, bytes);
        answer = `[月报](/api/v1/files/${artifact.object.id}/download)`;
        const requestsBefore = harness.model.requests.length;
        const result = await task.run();
        if (task.snapshot.finalDeliveryPolicy)
          await assertDeliveryProof(harness, subject, task, result, artifact);
        await completeDelivery(task, result);
        expect(await deliveryState(db, task.runId)).toMatchObject({
          status: 'succeeded',
          state: 'succeeded',
          text: answer,
          successes: 1,
        });
        expect(harness.model.requests.length - requestsBefore).toBe(1);
        expect(await readDeliveryBytes(resources, artifact)).toEqual(bytes);
        expect(artifact.object.checksum).toBe(sha256(bytes));
        const messages =
          await db`select id,role,status,content from allrice_messages where id in (select user_message_id from allrice_employee_runs where run_id=${task.runId} union all select assistant_message_id from allrice_employee_runs where run_id=${task.runId}) order by id`;
        const [version] =
          await db`select * from allrice_deliverable_versions where id=${artifact.version.id}`;
        const [binding] =
          await db`select * from allrice_native_session_bindings where context_id=${subject.sessionId}`;
        const [chat] =
          await db`select native_root_origin from allrice_chat_sessions where id=${subject.sessionId}`;
        expect(binding).toBeDefined();
        expect(
          await db`select root_run_id from allrice_assistant_roots where root_run_id=${task.runId}`,
        ).toHaveLength(0);
        cohorts.push({
          ...subject,
          kind,
          workAutomationBefore: settings[0]
            ? (jsonValue(settings[0]) as DeliveryCohort['workAutomationBefore'])
            : null,
          nativePreferencesBefore: [],
          auditEventIds: audits.map((row) => row.id),
          auditEventsBefore: jsonValue(audits) as unknown[],
          ordinaryRuns: [
            {
              runId: task.runId,
              jobId: task.workflowLease.jobId,
              messageIds: messages.map((row) => row.id),
              artifactVersionIds: [artifact.version.id],
              checksums: [artifact.object.checksum],
              artifact,
              bytesBase64: bytes.toString('base64'),
              runBefore: jsonValue(await deliveryState(db, task.runId)),
              messagesBefore: jsonValue(messages),
              versionBefore: jsonValue(version),
              bindingBefore: jsonValue(binding),
              originBefore: jsonValue(chat!.native_root_origin),
              nativeJournalDigest: sha256(await harness.journal()),
              nativeSessionId: binding!.native_session_id,
              modelRequests: 1,
            },
          ],
        });
      } finally {
        await task.cleanup();
      }
    }
    const active =
      await resources.db`select id from allrice_jobs where status in ('queued','claimed','running')`;
    expect(active).toHaveLength(0);
    expect(
      await resources.db`select id from allrice_jobs where worker_id is not null or lease_token is not null`,
    ).toHaveLength(0);
  } finally {
    await harness.close();
    vi.unstubAllEnvs();
  }
  return { cohorts, oldWritersStopped: true };
}
