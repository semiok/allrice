/** Isolated synthetic fixture; never imported by a production entrypoint. */
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../storage/src/index.ts';
import postgres from 'postgres';
import {
  type RequestContext,
  defaultAssistantRunConfiguration,
} from '@allrice/contracts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
import { createRuntimeOperationLedger } from './runtime-ledger/ledger.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
import { employeeManifest } from './employees/employee-config.ts';
const stores = new WeakMap<ReturnType<typeof postgres>, LocalStorageAdapter>();
export function assistantFixtureStorage(db: ReturnType<typeof postgres>) {
  const storage = stores.get(db);
  if (!storage) throw Error('Isolated fixture storage required');
  return storage;
}

export interface AssistantFixtureCleanupProof {
  schema: string;
  schemaRemoved: boolean;
  storageRoot: string | null;
  storageRemoved: boolean;
  databaseClosed: boolean;
  adminClosed: boolean;
}
export class AssistantFixtureInitializationError extends Error {
  constructor(
    readonly cleanup: AssistantFixtureCleanupProof,
    cause: unknown,
  ) {
    super('assistant_fixture_initialization_failed', { cause });
  }
}
export class AssistantFixtureCleanupError extends Error {
  constructor(readonly cleanup: AssistantFixtureCleanupProof) {
    super('assistant_fixture_cleanup_unconfirmed');
  }
}

export async function createAssistantFixtureDatabase(
  options: {
    throughMigration?:
      | '0096_assistant_pricing.sql'
      | '0100_tenant_scoped_resource_quotas.sql'
      | '0101_development_cooperation.sql';
  } = {},
) {
  if (
    options.throughMigration !== undefined &&
    ![
      '0096_assistant_pricing.sql',
      '0100_tenant_scoped_resource_quotas.sql',
      '0101_development_cooperation.sql',
    ].includes(options.throughMigration)
  )
    throw Error('Unsupported isolated migration checkpoint');
  const value = process.env.ALLRICE_TEST_DATABASE_URL;
  if (!value) throw Error('Dedicated ALLRICE_TEST_DATABASE_URL required');
  const url = new URL(value);
  assertRuntimeFixtureDatabase(url);
  const schema = `p25_${randomUUID().replaceAll('-', '')}`;
  let admin: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof postgres> | undefined;
  let storageRoot: string | undefined;
  let storageAttempted = false;
  let disposal: Promise<AssistantFixtureCleanupProof> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      const proof: AssistantFixtureCleanupProof = {
        schema,
        schemaRemoved: false,
        storageRoot: storageRoot ?? null,
        storageRemoved: !storageAttempted,
        databaseClosed: !db,
        adminClosed: !admin,
      };
      try {
        await db?.end({ timeout: 5 });
        proof.databaseClosed = true;
      } catch {
        /* Unconfirmed, not closed. */
      }
      if (admin && /^p25_[a-f0-9]{32}$/.test(schema)) {
        try {
          // The generated UUID is owned by this call, including an ambiguous
          // CREATE acknowledgement. Never target another schema or search_path.
          await admin.unsafe(`drop schema if exists "${schema}" cascade`);
          const [row] = await admin<
            { absent: boolean }[]
          >`select to_regnamespace(${schema}) is null as absent`;
          proof.schemaRemoved = row?.absent === true;
        } catch {
          /* Failed DROP/confirmation is an explicit unknown cleanup. */
        }
      }
      try {
        await admin?.end({ timeout: 5 });
        proof.adminClosed = true;
      } catch {
        /* Retain uncertainty. */
      }
      if (storageRoot && proof.databaseClosed) {
        try {
          await rm(storageRoot, { recursive: true, force: true });
          proof.storageRemoved = await lstat(storageRoot).then(
            () => false,
            (error: unknown) => {
              if (
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT'
              )
                return true;
              throw error;
            },
          );
        } catch {
          proof.storageRemoved = false;
        }
      }
      // A failed mkdtemp with no returned path is not proof of filesystem absence.
      if (db && proof.databaseClosed) stores.delete(db);
      return proof;
    })());
  try {
    admin = postgres(url.toString(), {
      max: 1,
      onnotice: () => {},
      connect_timeout: 5,
      connection: {
        application_name: schema,
        lock_timeout: 5000,
        statement_timeout: 5000,
      },
    });
    await admin.unsafe(`create schema "${schema}"`);
    // An incremental checkpoint must not borrow tables introduced by later
    // migrations from a fully migrated public schema (as CI db:setup has).
    const searchPath = options.throughMigration ? schema : `${schema},public`;
    url.searchParams.set('options', `-csearch_path=${searchPath}`);
    db = postgres(url.toString(), {
      max: 10,
      onnotice: () => {},
      connect_timeout: 5,
      connection: { application_name: schema },
    });
    storageAttempted = true;
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p25-artifacts-'));
    stores.set(db, new LocalStorageAdapter(storageRoot));
    const migrations = new URL('../migrations/', import.meta.url);
    await db.begin(async (tx) => {
      // Historical bootstrap SQL uses extension types/operators installed in
      // public. This transaction-local path expires before the checkpoint pool
      // is returned; subsequent migration/runtime readers remain own-only.
      if (options.throughMigration)
        await tx`select set_config('search_path', ${`${schema},public`}, true)`;
      const files = (await readdir(migrations))
        .filter((f) => f.endsWith('.sql'))
        .sort();
      if (options.throughMigration && !files.includes(options.throughMigration))
        throw Error('Isolated migration checkpoint missing');
      for (const file of files) {
        if (options.throughMigration && file > options.throughMigration) break;
        await tx.unsafe(await readFile(new URL(file, migrations), 'utf8'));
      }
    });
    return {
      db,
      async close() {
        const proof = await dispose();
        if (
          !proof.schemaRemoved ||
          !proof.storageRemoved ||
          !proof.databaseClosed ||
          !proof.adminClosed
        )
          throw new AssistantFixtureCleanupError(proof);
        return proof;
      },
    };
  } catch (error) {
    throw new AssistantFixtureInitializationError(await dispose(), error);
  }
}
export async function assistantFixture(
  db: ReturnType<typeof postgres>,
  capacity = 12,
  options: { nativeSessionId?: string } = {},
) {
  const org = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    runId = randomUUID(),
    jobId = randomUUID(),
    workerId = randomUUID(),
    leaseToken = randomUUID(),
    sessionId = randomUUID(),
    employeeId = randomUUID(),
    versionId = randomUUID(),
    assignmentId = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'P25 fixture','not-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${org},${`p25-${org}`},'P25 fixture')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${org},'test','P25 fixture')`;
  await db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${randomUUID()},${org},${workspace},${user},'admin')`;
  const manifest = employeeManifest({
    key: 'p25-fixture',
    name: 'P25 Fixture',
    description: 'Synthetic fixture only',
    toolNames: [
      'assistant.delegate',
      'assistant.report',
      'workspace.document.read',
    ],
  });
  await db`insert into allrice_employees(id,organization_id,workspace_id,employee_key,name) values(${employeeId},${org},${workspace},'p25-fixture','P25 Fixture')`;
  await db`insert into allrice_employee_versions(id,organization_id,workspace_id,employee_id,version,name,model,system_prompt,capabilities,config_checksum,manifest,provider_snapshot) values(${versionId},${org},${workspace},${employeeId},1,'P25 Fixture',${manifest.provider.model},${manifest.systemPrompt},${db.json(manifest.capabilities)},${`sha256:${'a'.repeat(64)}`},${db.json(manifest)},${db.json(manifest.provider)})`;
  await db`insert into allrice_employee_assignments(id,organization_id,workspace_id,employee_id,employee_version_id,user_id) values(${assignmentId},${org},${workspace},${employeeId},${versionId},${user})`;
  await db`insert into allrice_chat_sessions(id,organization_id,workspace_id,owner_id,title,employee_assignment_id,employee_version_id) values(${sessionId},${org},${workspace},${user},'Synthetic assistant session',${assignmentId},${versionId})`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${runId},${org},${workspace},${user},'running','{}','{}')`;
  await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
    values(${jobId},${org},${workspace},${user},${runId},'running',${randomUUID()},clock_timestamp()+interval '10 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes')`;
  const task = {
    scope: { organizationId: org, workspaceId: workspace, projectId: null },
    runId,
    rootRunId: runId,
    parentRunId: null,
    chatSessionId: sessionId,
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
  const nativeSessionId = options.nativeSessionId ?? randomUUID();
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
    async artifact(
      childRunId: string,
      body = 'Synthetic checked evidence',
      artifactOwnerId = user,
    ) {
      const artifactId = randomUUID(),
        objectId = randomUUID(),
        key = `organizations/${org}/workspaces/${workspace}/owners/${artifactOwnerId}/artifacts/${objectId}`;
      const bytes = Buffer.from(body),
        digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const object = {
        id: objectId,
        organizationId: org,
        workspaceId: workspace,
        ownerId: artifactOwnerId,
        key,
        checksum: digest,
        sizeBytes: bytes.length,
        mediaType: 'text/plain',
        retentionUntil: null,
        deletedAt: null,
        immutable: true,
      };
      const storage = stores.get(db);
      if (!storage) throw Error('Isolated fixture storage required');
      await storage.put(object, new Blob([bytes]).stream());
      await db`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,media_type,size_bytes,checksum,state,immutable) values(${objectId},${org},${workspace},${artifactOwnerId},${key},'artifacts','text/plain',${bytes.length},${digest},'ready',true)`;
      await db`insert into allrice_deliverable_versions(id,organization_id,workspace_id,owner_id,object_id,series_id,version,session_id,file_name,format) values(${artifactId},${org},${workspace},${artifactOwnerId},${objectId},${randomUUID()},1,${sessionId},'evidence.txt','text')`;
      await db`insert into allrice_workbench_artifacts(version_id,organization_id,workspace_id,owner_id,run_id,kind,provenance,request_id,request_digest) values(${artifactId},${org},${workspace},${artifactOwnerId},${childRunId},'document',${db.json({ kind: 'tool_result', runId: childRunId, operationId: null, stepId: null })},${randomUUID()},${digest})`;
      return { artifactId, digest };
    },
  };
}
