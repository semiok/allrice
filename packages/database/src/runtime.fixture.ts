/** Isolated synthetic fixture; never imported by a production entrypoint. */
import { randomUUID } from 'node:crypto';
import {
  readFile,
  readdir,
  mkdtemp,
  realpath,
  rm,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageAdapter } from '../../storage/src/index.ts';
import postgres from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';
const stores = new WeakMap<ReturnType<typeof postgres>, LocalStorageAdapter>();
export function runtimeFixtureStorage(db: ReturnType<typeof postgres>) {
  const storage = stores.get(db);
  if (!storage) throw Error('Isolated fixture storage required');
  return storage;
}

export interface RuntimeFixtureCleanupProof {
  schema: string;
  schemaRemoved: boolean;
  storageRoot: string | null;
  storageRemoved: boolean;
  databaseClosed: boolean;
  adminClosed: boolean;
}
export class RuntimeFixtureInitializationError extends Error {
  constructor(
    readonly cleanup: RuntimeFixtureCleanupProof,
    cause: unknown,
  ) {
    super('assistant_fixture_initialization_failed', { cause });
  }
}
export class RuntimeFixtureCleanupError extends Error {
  constructor(readonly cleanup: RuntimeFixtureCleanupProof) {
    super('assistant_fixture_cleanup_unconfirmed');
  }
}

export async function createRuntimeFixtureDatabase(
  options: {
    // Fault-injection suites must never borrow a relation from CI's public DB.
    ownSchemaOnly?: true;
    throughMigration?:
      | '0096_assistant_pricing.sql'
      | '0100_tenant_scoped_resource_quotas.sql'
      | '0101_development_cooperation.sql'
      | '0201_workbench_file_policies.sql'
      | '0210_current_employee_execution_binding.sql'
      | '0217_brand_content_feedback.sql'
      | '0223_agent_preferences.sql';
  } = {},
) {
  if (options.ownSchemaOnly !== undefined && options.ownSchemaOnly !== true)
    throw Error('Unsupported isolated search path');
  if (
    options.throughMigration !== undefined &&
    ![
      '0096_assistant_pricing.sql',
      '0100_tenant_scoped_resource_quotas.sql',
      '0101_development_cooperation.sql',
      '0201_workbench_file_policies.sql',
      '0210_current_employee_execution_binding.sql',
      '0217_brand_content_feedback.sql',
      '0223_agent_preferences.sql',
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
  let disposal: Promise<RuntimeFixtureCleanupProof> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      const proof: RuntimeFixtureCleanupProof = {
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
    const ownSchemaOnly = options.throughMigration || options.ownSchemaOnly;
    const searchPath = ownSchemaOnly ? schema : `${schema},public`;
    url.searchParams.set('options', `-csearch_path=${searchPath}`);
    db = postgres(url.toString(), {
      max: 10,
      onnotice: () => {},
      connect_timeout: 5,
      connection: { application_name: schema },
    });
    storageAttempted = true;
    storageRoot = await mkdtemp(join(tmpdir(), 'allrice-p25-artifacts-'));
    // macOS tmpdir is /var/..., a symlink to /private/var/...: code under test
    // that requires realpath(path) === path must see the canonical root.
    storageRoot = await realpath(storageRoot);
    stores.set(db, new LocalStorageAdapter(storageRoot));
    const migrations = new URL('../migrations/', import.meta.url);
    await db.begin(async (tx) => {
      // Historical bootstrap SQL uses extension types/operators installed in
      // public. This transaction-local path expires before the checkpoint pool
      // is returned; subsequent migration/runtime readers remain own-only.
      if (ownSchemaOnly)
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
      storageRoot,
      async close() {
        const proof = await dispose();
        if (
          !proof.schemaRemoved ||
          !proof.storageRemoved ||
          !proof.databaseClosed ||
          !proof.adminClosed
        )
          throw new RuntimeFixtureCleanupError(proof);
        return proof;
      },
    };
  } catch (error) {
    throw new RuntimeFixtureInitializationError(await dispose(), error);
  }
}

/** Tenant/member/job identity only: no assistant or runtime state is created. */
export async function runFixture(db: ReturnType<typeof postgres>) {
  const organizationId = randomUUID(),
    workspaceId = randomUUID(),
    user = randomUUID(),
    runId = randomUUID(),
    jobId = randomUUID(),
    workerId = randomUUID(),
    leaseToken = randomUUID();
  await db`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'Run fixture','not-login')`;
  await db`insert into allrice_organizations(id,slug,name) values(${organizationId},${`run-${organizationId}`},'Run fixture')`;
  await db`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${organizationId},'test','Run fixture')`;
  await db`insert into allrice_memberships(id,organization_id,workspace_id,user_id,role) values(${randomUUID()},${organizationId},${workspaceId},${user},'admin')`;
  await db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${runId},${organizationId},${workspaceId},${user},'running','{}','{}')`;
  await db`insert into allrice_jobs(id,organization_id,workspace_id,owner_id,run_id,status,idempotency_key,timeout_at,payload,worker_id,lease_token,claimed_at,heartbeat_at,lease_expires_at)
    values(${jobId},${organizationId},${workspaceId},${user},${runId},'running',${randomUUID()},clock_timestamp()+interval '10 minutes','{"schemaVersion":1,"type":"allrice.employee.run","input":{}}',${workerId},${leaseToken},clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes')`;
  const context: RequestContext = {
    actor: { type: 'user', id: user },
    organizationId,
    workspaceId,
    requestId: randomUUID(),
    sessionId: randomUUID(),
    authenticatedAt: new Date().toISOString(),
    memberships: [],
  };
  return {
    task: {
      scope: { organizationId, workspaceId, projectId: null as string | null },
      runId,
      rootRunId: runId,
      parentRunId: null,
      chatSessionId: null as string | null,
      frozenConfiguration: {
        employeeVersionId: null as string | null,
        digest: `sha256:${'a'.repeat(64)}`,
      },
    },
    context,
    worker: { jobId, workerId, leaseToken, generation: 1 },
  };
}
