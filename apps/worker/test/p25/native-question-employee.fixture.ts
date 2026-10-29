/** Shared real message -> queue -> employee Worker -> native Host fixture.
 * Synthetic loopback model and artifact approval only; no model subscription. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, vi } from 'vitest';
import type { HarnessEvent } from '@allrice/contracts';
import * as DatabaseClient from '../../../../packages/database/src/core/client.ts';
import { createAssistantFixtureDatabase } from '../../../../packages/database/src/assistant-runtime.fixture.ts';
import { createAssistantAuthorityFixture } from '../../../../packages/database/src/assistant-authority.fixture.ts';
import { authorizeFixturePlatformAdministrator } from '../../../../packages/database/src/platform-authority.fixture.ts';
import {
  createSession,
  authenticateSession,
} from '../../../../packages/database/src/identity.ts';
import {
  createAssignedChatSession,
  sendChatMessage,
} from '../../../../packages/database/src/workspace/service.ts';
import { upsertEmployeeModelPolicy } from '../../../../packages/database/src/providers/model-pool.ts';
import * as ModelPool from '../../../../packages/database/src/providers/model-pool.ts';
import { updateNativeQuestionMode } from '../../../../packages/database/src/native-questions.ts';
import { claimNextJob } from '../../../../packages/database/src/execution/queue.ts';
import { executeEmployeeRun } from '../../src/jobs/employee-run.ts';
import { runClaimedJob } from '../../src/job-runner.ts';
import { DshHarnessAdapter } from '../../src/harness/dsh-adapter.ts';
import * as Router from '../../src/harness/router.ts';
import * as NativeArtifact from '../../src/harness/dsh-native-artifact.ts';
import {
  DSH_DISTRIBUTION_CURRENT_GENERATION,
  DSH_DISTRIBUTION_CURRENT_VERSION,
} from '../../src/harness/dsh-distribution.ts';
import { p24Fixture } from '../p24/fixture.ts';
export async function setupNativeReplyEmployee(
  reply: Parameters<typeof p24Fixture>[0],
  existing?: {
    db: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>['db'];
    identity: {
      org: string;
      workspace: string;
      user: string;
      employee: string;
      assignment: string;
      instanceId?: string;
    };
  },
) {
  const environment = new Map(
    [
      'ALLRICE_ASSISTANTS_ENABLED',
      'ALLRICE_WORKBENCH_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_GEMINI_API_ENABLED',
      'ALLRICE_DSH_NATIVE_ARTIFACT_ID',
      'ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID',
      'ALLRICE_STORAGE_ROOT',
      'ALLRICE_DSH_PLATFORM_HOME',
    ].map((key) => [key, process.env[key]]),
  );
  let adapter: DshHarnessAdapter;
  // This historical fixture seeds an unused assistant root. Product chat
  // admission below runs with the switch off and no assistant preference.
  vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
  vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
  vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
  vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
  const artifactId = `sha256:${'a'.repeat(64)}`;
  vi.stubEnv('ALLRICE_DSH_NATIVE_ARTIFACT_ID', artifactId);
  vi.stubEnv('ALLRICE_DSH_NEW_ROOT_ARTIFACT_ID', artifactId);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), 'native-reply-routing-')),
  );
  vi.stubEnv('ALLRICE_STORAGE_ROOT', join(directory, 'storage'));
  vi.stubEnv(
    'ALLRICE_DSH_PLATFORM_HOME',
    join(directory, 'unused-platform-home'),
  );
  const fixture = existing ? undefined : await createAssistantFixtureDatabase();
  const db = existing?.db ?? fixture!.db;
  vi.spyOn(DatabaseClient, 'getDatabase').mockReturnValue(db);
  const model = await p24Fixture(reply);
  const launch = {
    artifactId,
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
  vi.spyOn(NativeArtifact, 'checkedDshNativeLaunch').mockReturnValue({
    artifactId,
    profileId: 'restricted',
  });
  vi.spyOn(NativeArtifact, 'currentDshNativeLaunch').mockImplementation(
    (profile) => {
      expect(profile).toBe('restricted');
      return launch;
    },
  );
  const makeAdapter = () =>
    new DshHarnessAdapter({
      runtimeRoot: join(directory!, 'native'),
      idleCloseMs: 0,
      requestTimeoutMs: 15000,
      credentialResolver: {
        resolve: async () => ({ apiKey: 'synthetic-loopback-only' }),
      },
    });
  adapter = makeAdapter();
  const router = vi
    .spyOn(Router, 'getHarnessRouter')
    .mockReturnValue(new Router.HarnessRouter([adapter]));
  const restartHost = async () => {
    await adapter!.close();
    adapter = makeAdapter();
    router.mockReturnValue(new Router.HarnessRouter([adapter]));
  };
  const identity =
    existing?.identity ??
    (await createAssistantAuthorityFixture(db, {
      configure: false,
      allowedTools: ['workspace.export.create', 'workspace.document.read'],
      runtimePolicy: {
        harness: 'dsh',
        provider: 'openai-compatible',
        model: 'pr1b-synthetic',
        reasoningEffort: 'low',
        timeoutMs: 300000,
        fallbackModels: [],
        credentialReference: 'test:pr1b-synthetic',
        baseUrl: model.baseUrl,
      },
    }));
  vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
  const login = await createSession(identity.user);
  const context = (await authenticateSession(login.token, {
    organizationId: identity.org,
    workspaceId: identity.workspace,
  }))!;
  await authorizeFixturePlatformAdministrator(db, identity.user);
  await updateNativeQuestionMode(context, 'timed');
  const connectionId = randomUUID(),
    catalogId = randomUUID(),
    modelId = `pr1b-synthetic-${connectionId}`;
  await db`insert into allrice_model_providers(id,provider_key,name,harness,auth_mode,enabled)
      values(${randomUUID()},'openai-compatible','Synthetic loopback','dsh','api_key',true)
      on conflict(provider_key) do update set enabled=true`;
  const [provider] =
    await db`select id from allrice_model_providers where provider_key='openai-compatible'`;
  await db`insert into allrice_model_connections(id,provider_id,scope,name,credential_reference,base_url,status)
      values(${connectionId},${provider!.id},'platform',${modelId},'test:pr1b-synthetic',${model.baseUrl},'ready')`;
  await db`insert into allrice_model_catalog_entries(id,provider_id,model,display_name,reasoning_efforts,default_reasoning_effort,input_modalities,output_modalities,enabled)
      values(${catalogId},${provider!.id},${modelId},'Synthetic loopback','["low"]','low','["text"]','["text"]',true)`;
  await upsertEmployeeModelPolicy({
    context,
    workspaceId: identity.workspace,
    employeeId: identity.employee,
    policy: {
      connectionId,
      modelCatalogEntryId: catalogId,
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
  // Current product admission deliberately selects the platform subscription.
  // Substitute only its model target BEFORE the Run is frozen, so all native
  // requests use the local HTTP responder and never inspect OAuth material.
  const freezeModel = ModelPool.freezeSessionModelSnapshot;
  vi.spyOn(ModelPool, 'freezeSessionModelSnapshot').mockImplementation(
    async (input, database) => {
      const frozen = await freezeModel(input, database);
      const snapshot = {
        ...frozen,
        connectionId,
        modelCatalogEntryId: catalogId,
        provider: 'openai-compatible',
        authMode: 'api_key' as const,
        model: 'pr1b-synthetic',
        credentialReference: 'test:pr1b-synthetic',
        baseUrl: model!.baseUrl,
      };
      const sql = database ?? db;
      await sql`update allrice_session_model_snapshots set connection_id=${connectionId},model_catalog_entry_id=${catalogId},snapshot=${sql.json(snapshot)} where session_id=${input.sessionId}`;
      return snapshot;
    },
  );
  const chat = await createAssignedChatSession(context, {
    workspaceId: identity.workspace,
    employeeAssignmentId: identity.assignment,
    ...(existing?.identity.instanceId
      ? { employeeInstanceId: existing.identity.instanceId }
      : {}),
    title: 'PR1b synthetic Worker',
  });
  return {
    db,
    identity,
    context,
    chat,
    artifactId,
    restartHost,
    model,
    directory,
    get adapter() {
      return adapter;
    },
    close: async () => {
      await adapter.close();
      await model.close();
      await fixture?.close();
      await rm(directory, { recursive: true, force: true });
      for (const [key, value] of environment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
type Setup = Awaited<ReturnType<typeof setupNativeReplyEmployee>>;
export async function sendNativeReplyMessage(
  f: Setup,
  text: string,
  answer?: {
    questionId: string;
    answers: { id: string; selected: string[] }[];
  },
) {
  return sendChatMessage(f.context, f.identity.workspace, f.chat.id, {
    clientMessageId: randomUUID(),
    text,
    ...(answer
      ? { userQuestionAnswer: answer }
      : {
          deliveryMode: 'follow_up',
          assistantPreference: { mode: 'daily', allowAssistants: false },
        }),
  });
}
export async function executeNativeReplyJob(
  f: Setup,
  runId: string,
  state = 'succeeded',
  hooks: {
    onEvent?(event: HarnessEvent): Promise<void>;
    afterHandler?(
      result: Awaited<ReturnType<typeof executeEmployeeRun>>,
      lease: Parameters<typeof executeEmployeeRun>[0]['workflowLease'],
    ): Promise<void>;
    crashAfterHandler?: boolean;
  } = {},
) {
  const workerId = randomUUID();
  const job = (await claimNextJob(workerId, 300000))!;
  expect(job.id).toBe(
    (await f.db`select id from allrice_jobs where run_id=${runId}`)[0]!.id,
  );
  let crashed = false;
  await runClaimedJob(
    {
      workerId,
      jobId: job.id,
      leaseToken: job.lease!.token,
      leaseMs: 300000,
      heartbeatMs: 1000,
      executionRoot: join(f.directory, 'execution'),
      stopping: () => crashed,
      onAbortReady() {},
    },
    async (input) => {
      const result = await executeEmployeeRun({
        ...input,
        onHarnessEvent: async (event) => {
          await input.onHarnessEvent(event);
          await hooks.onEvent?.(event);
        },
      });
      await hooks.afterHandler?.(result, input.workflowLease);
      if (hooks.crashAfterHandler) {
        // Real command/Host result is committed; simulate process loss before
        // runClaimedJob can call completeJob. Recover through maintainQueue.
        await f.db`update allrice_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=${job.id}`;
        crashed = true;
        throw Error(
          'Synthetic crash after terminal command, before completeJob',
        );
      }
      return result;
    },
  );
  const [run] =
    await f.db`select r.state,r.result,r.error_code,j.last_error_code,j.last_error_message,j.status,j.lease_token from allrice_runs r
      join allrice_jobs j on j.run_id=r.id where r.id=${runId}`;
  expect(run, JSON.stringify(run)).toMatchObject({
    state,
    status: state,
    lease_token: crashed ? job.lease!.token : null,
  });
  return run!;
}
