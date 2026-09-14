/** Isolated synthetic fixture; never imported by a production entrypoint. */
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import {
  type RequestContext,
  defaultAssistantRunConfiguration,
} from '@allrice/contracts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';

export async function createAssistantFixtureDatabase() {
  const value = process.env.ALLRICE_TEST_DATABASE_URL;
  if (!value) throw Error('Dedicated ALLRICE_TEST_DATABASE_URL required');
  const url = new URL(value);
  assertRuntimeFixtureDatabase(url);
  const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const schema = `p25_${randomUUID().replaceAll('-', '')}`;
  await admin.unsafe(`create schema "${schema}"`);
  url.searchParams.set('options', `-csearch_path=${schema},public`);
  const db = postgres(url.toString(), { max: 10, onnotice: () => {} });
  try {
    const migrations = new URL('../migrations/', import.meta.url);
    await db.begin(async (tx) => {
      for (const file of (await readdir(migrations))
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await tx.unsafe(await readFile(new URL(file, migrations), 'utf8'));
    });
  } catch (error) {
    await db.end();
    await admin.unsafe(`drop schema "${schema}" cascade`);
    await admin.end();
    throw error;
  }
  return {
    db,
    async close() {
      await db.end({ timeout: 5 });
      if (!/^p25_[a-f0-9]{32}$/.test(schema))
        throw Error('Invalid fixture schema');
      await admin.unsafe(`drop schema "${schema}" cascade`);
      await admin.end({ timeout: 5 });
    },
  };
}
export async function assistantFixture(
  db: ReturnType<typeof postgres>,
  capacity = 12,
) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    runId = randomUUID(),
    jobId = randomUUID(),
    workerId = randomUUID(),
    leaseToken = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'P25 fixture','not-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${org},${`p25-${org}`},'P25 fixture')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','P25 fixture')`;
  await db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${randomUUID()},${org},${workspace},${user},'admin')`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${runId},${org},${workspace},${user},'running','{}','{}')`;
  await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
    values(${jobId},${org},${workspace},${user},${runId},'running',${randomUUID()},clock_timestamp()+interval '10 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes')`;
  const task = {
    scope: { organizationId: org, workspaceId: workspace, projectId: null },
    runId,
    rootRunId: runId,
    parentRunId: null,
    chatSessionId: null,
    frozenConfiguration: {
      employeeVersionId: null,
      digest: `sha256:${'a'.repeat(64)}`,
    },
  };
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId: org,
    workspaceId: workspace,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    authenticatedAt: new Date().toISOString(),
    memberships: [],
  };
  const worker = { jobId, workerId, leaseToken, generation: 1 };
  const ledger = createRuntimeOperationLedger({
    database: db,
    admission: async () => {},
  });
  await ledger.createRoot({
    task,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    budgets: [
      {
        metric: 'model_calls',
        unit: 'calls',
        currency: null,
        capacity,
        source: { kind: 'worker', sourceId: 'assistant-native-v1' },
      },
      {
        metric: 'tool_calls',
        unit: 'calls',
        currency: null,
        capacity: 100,
        source: { kind: 'worker', sourceId: 'assistant-native-v1' },
      },
      {
        metric: 'input_tokens',
        unit: 'tokens',
        currency: null,
        capacity: 100000,
        source: { kind: 'worker', sourceId: 'assistant-native-v1' },
      },
      {
        metric: 'output_tokens',
        unit: 'tokens',
        currency: null,
        capacity: 100000,
        source: { kind: 'worker', sourceId: 'assistant-native-v1' },
      },
    ],
  });
  let revoked = false;
  const runtime = createAssistantRuntime({
    database: db,
    authorize: async () => {
      if (revoked) throw Error('revoked');
    },
  });
  const nativeSessionId = randomUUID();
  const config = {
    ...defaultAssistantRunConfiguration(),
    allowAssistants: true,
    maxConcurrent: 4,
    maxDepth: 3,
  };
  await runtime.configureRoot({
    task,
    configuration: config,
    nativeSessionId,
    worker,
    allowedTools: [
      'read',
      'proposal',
      'assistant.delegate',
      'assistant.report',
    ],
  });
  const base = { scope: task.scope, rootRunId: runId, worker };
  const delegate = (
    overrides: Partial<Parameters<typeof runtime.provision>[0]> = {},
  ) =>
    runtime.provision({
      ...base,
      parentRunId: runId,
      delegationId: randomUUID(),
      label: 'Read-only helper',
      text: 'Analyze synthetic input',
      tools: ['read'],
      ...overrides,
    });
  return {
    db,
    task,
    context,
    worker,
    runtime,
    base,
    delegate,
    ledger,
    config,
    nativeSessionId,
    revoke() {
      revoked = true;
    },
  };
}
