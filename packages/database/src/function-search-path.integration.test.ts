import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const migrations = new URL('../migrations/', import.meta.url);
const migrationName = '0225_function_search_path.sql';
const options = { max: 1, onnotice: () => {} };

function pgClient(command: 'pg_dump' | 'pg_restore', url: URL, input?: Buffer) {
  // m5-test supplies matching PostgreSQL clients. CI uses its PostgreSQL
  // container's clients via PATH wrappers, with the archive on stdin/stdout.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PG')) delete env[key];
  Object.assign(env, {
    PGHOST: url.hostname,
    PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
  });
  const result = spawnSync(
    command,
    command === 'pg_dump'
      ? ['--format=custom']
      : ['--exit-on-error', '--dbname', env.PGDATABASE!],
    { env, input, timeout: 60_000, maxBuffer: 32 * 1024 ** 2 },
  );
  if (result.error) throw result.error;
  return result;
}

suite('0225 function search_path and standard backup restore', () => {
  it('restores CHECK-validated calendar and conversation data with unmodified pg_restore', async () => {
    const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
    assertRuntimeFixtureDatabase(url);
    const admin = postgres(url.toString(), options);
    const databases: string[] = [];
    const clients: ReturnType<typeof postgres>[] = [];
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'allrice-function-restore-')),
    );
    async function database() {
      const name = `allrice_restore_${randomUUID().replaceAll('-', '')}`;
      databases.push(name);
      await admin.unsafe(`create database "${name}" template template0`);
      const target = new URL(url);
      target.pathname = `/${name}`;
      const db = postgres(target.toString(), options);
      clients.push(db);
      return { db, url: target };
    }
    try {
      const source = await database();
      await source.db.begin(async (tx) => {
        for (const name of (await readdir(migrations))
          .filter((name) => name.endsWith('.sql') && name < migrationName)
          .sort())
          await tx.unsafe(await readFile(new URL(name, migrations), 'utf8'));
      });
      // Copy the real CHECKs, including native_recurring_control_kind, while
      // leaving unrelated tenant FKs/triggers out of this backup regression.
      await source.db.unsafe(`
        create table restore_controls (like allrice_native_recurring_controls including defaults including constraints);
        create table restore_versions (like allrice_native_recurring_versions including defaults including constraints);
        create table restore_conversations (conversation_snapshot jsonb);
        create table restore_revocations (id uuid, revoked_at timestamptz);
        create trigger restore_revoked after update on restore_revocations
          for each row execute function allrice_notify_bridge_device_revoked();
      `);
      const [check] =
        await source.db`select pg_get_constraintdef(oid) as definition from pg_constraint
        where conrelid='allrice_automation_runs'::regclass and conname='automation_conversation_snapshot_shape'`;
      await source.db.unsafe(
        `alter table restore_conversations add constraint conversation_snapshot_shape ${check!.definition}`,
      );
      const automationId = randomUUID(),
        sessionId = randomUUID();
      const control = {
        kind: 'calendar',
        binding: 'rotating-at-v1',
        partitionId: 'allrice-recurring-v1',
        controlId: randomUUID(),
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        ownerId: randomUUID(),
        automationId,
        revision: 1,
        controlSessionId: 'restore-monthly',
        sessionState: 'reserved',
        nativeTaskId: null,
        reference: {
          artifactId: 'restore-artifact',
          profileId: 'allrice-recurring-control-v1',
          storageId: 'restore-storage',
          stateRoot: '/restore',
        },
        dispatch: {
          consumer: 'ordinary-monthly-v1',
          employeeAssignmentId: randomUUID(),
          employeeInstanceId: randomUUID(),
          businessSessionId: sessionId,
        },
      };
      await source.db`insert into restore_controls(partition_id,control_id,automation_id,control_session_id,immutable_identity,snapshot)
        values(${control.partitionId},${control.controlId},${automationId},${control.controlSessionId},
          ${source.db.json(control)}::jsonb-array['revision','sessionState','nativeTaskId'],
          jsonb_build_object('control',${source.db.json(control)}::jsonb,'task',null))`;
      const content = { name: '每月提醒', prompt: '每月一号提醒我核对账单' };
      const [digest] =
        await source.db`select allrice_native_control_document_digest(${source.db.json(content)}) as value`;
      const configuration = {
        kind: 'calendar',
        binding: 'rotating-at-v1',
        consumer: 'ordinary-monthly-v1',
        revision: 1,
        contentDigest: digest!.value,
        reservationDigest: `sha256:${'a'.repeat(64)}`,
        rule: {
          kind: 'monthly',
          monthDay: 1,
          time: '09:00:00',
          timezone: 'Asia/Shanghai',
        },
        acceptedAt: '2026-10-27T00:00:00.000Z',
      };
      await source.db`insert into restore_versions(automation_id,revision,configuration,business_content,business_content_digest)
        values(${automationId},1,${source.db.json(configuration)},${source.db.json(content)},${digest!.value})`;
      const conversation = {
        version: 1,
        automationId,
        businessRevision: 1,
        mode: 'reuse',
        sourceSessionId: sessionId,
        targetSessionId: sessionId,
        employeeAssignmentId: control.dispatch.employeeAssignmentId,
        employeeInstanceId: control.dispatch.employeeInstanceId,
        trigger: { kind: 'manual', requestId: randomUUID() },
      };
      await source.db`insert into restore_conversations values(${source.db.json(conversation)}::jsonb ||
        jsonb_build_object('digest',allrice_native_control_document_digest(${source.db.json(conversation)})))`;
      await source.db`insert into restore_revocations values(${randomUUID()},null)`;

      const oldDump = pgClient('pg_dump', source.url);
      expect(oldDump.status, oldDump.stderr.toString()).toBe(0);
      const broken = await database();
      const failed = pgClient('pg_restore', broken.url, oldDump.stdout);
      expect(failed.status).not.toBe(0);
      expect(failed.stderr.toString()).toMatch(
        /function allrice_.* does not exist/,
      );

      const before =
        await source.db`select oid, to_jsonb(p)-'proconfig' as definition, proconfig from pg_proc p
        where pronamespace='public'::regnamespace and starts_with(proname,'allrice_') order by oid`;
      const migration = await readFile(
        new URL(migrationName, migrations),
        'utf8',
      );
      await source.db.begin((tx) => tx.unsafe(migration));
      const after =
        await source.db`select oid, to_jsonb(p)-'proconfig' as definition, proconfig from pg_proc p
        where pronamespace='public'::regnamespace and starts_with(proname,'allrice_') order by oid`;
      expect(after.map((row) => row.definition)).toEqual(
        before.map((row) => row.definition),
      );
      const changed = after.filter(
        (row, index) =>
          JSON.stringify(row.proconfig) !==
          JSON.stringify(before[index]!.proconfig),
      );
      expect(changed).toHaveLength(83);
      for (const row of changed)
        expect(row.proconfig).toEqual(['search_path=public, pg_catalog']);
      // Reapplying changes no definitions/configuration and leaves row values intact.
      await source.db.begin((tx) => tx.unsafe(migration));

      const dump = pgClient('pg_dump', source.url);
      expect(dump.status, dump.stderr.toString()).toBe(0);
      const path = join(root, 'standard.dump');
      await writeFile(path, dump.stdout, { mode: 0o600 });
      const restored = await database();
      const result = pgClient('pg_restore', restored.url, await readFile(path));
      expect(result.status, result.stderr.toString()).toBe(0);
      for (const table of [
        'restore_controls',
        'restore_versions',
        'restore_conversations',
      ]) {
        const original = await source.db.unsafe(
          `select to_jsonb(t) as value from ${table} t`,
        );
        expect(original).toHaveLength(1);
        expect(
          await restored.db.unsafe(
            `select to_jsonb(t) as value from ${table} t`,
          ),
        ).toEqual(original);
      }
      await restored.db.unsafe("set search_path = ''");
      expect(
        await restored.db`select public.allrice_native_control_document_digest(${restored.db.json(content)}) as value`,
      ).toEqual([digest]);
      // Exercise a trigger's unqualified table reference after restore too.
      await restored.db`update public.restore_revocations set revoked_at=now()`;
      await expect(restored.db`update public.restore_conversations
        set conversation_snapshot=jsonb_set(conversation_snapshot,'{digest}', '"sha256:invalid"')`).rejects.toMatchObject(
        { code: '23514' },
      );
      await expect(restored.db`update public.restore_controls
        set snapshot=jsonb_set(snapshot,'{control,revision}', '0')`).rejects.toMatchObject(
        { code: '23514' },
      );
    } finally {
      await Promise.all(clients.map((db) => db.end({ timeout: 5 })));
      try {
        for (const name of databases)
          await admin.unsafe(`drop database if exists "${name}" with (force)`);
      } finally {
        await admin.end({ timeout: 5 });
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('binds isolated fixture functions to their own schema, including row types', async () => {
    const f = await createAssistantFixtureDatabase({ ownSchemaOnly: true });
    try {
      const [scope] = await f.db`select current_schema() as name`;
      const schema = scope!.name as string;
      const configs =
        await f.db`select proconfig from pg_proc where pronamespace=${schema}::regnamespace and proconfig is not null`;
      expect(configs).toHaveLength(83);
      for (const row of configs)
        expect(row.proconfig).toEqual([`search_path=${schema}, pg_catalog`]);
      await f.db.begin(async (tx) => {
        await tx.unsafe("set local search_path = ''");
        const [row] = await tx.unsafe(
          `select "${schema}".allrice_ordinary_monthly_decision_proved($1) as value`,
          [randomUUID()],
        );
        expect(row!.value).toBe(false);
        const [digest] = await tx.unsafe(
          `select "${schema}".allrice_native_control_canonical('{"b":[2,1],"a":0}') as value`,
        );
        expect(digest!.value).toBe('{"a":0,"b":[2,1]}');
      });
    } finally {
      await f.close();
    }
  }, 60_000);
});
