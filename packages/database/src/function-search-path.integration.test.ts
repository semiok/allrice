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
import { createRuntimeFixtureDatabase } from './runtime.fixture.ts';
import { assertRuntimeFixtureDatabase } from './runtime-fixture-database.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const migrations = new URL('../migrations/', import.meta.url);
const migrationName = '0225_function_search_path.sql';
const options = { max: 1, onnotice: () => {} };

async function functionCatalog(
  db: ReturnType<typeof postgres>,
  schema: string,
) {
  return db<
    {
      oid: number;
      proname: string;
      prosrc: string;
      proconfig: string[] | null;
      definition: unknown;
      checked: boolean;
    }[]
  >`
    select p.oid, p.proname, p.prosrc, p.proconfig,
      to_jsonb(p)-'proconfig' as definition,
      exists (
        select 1 from pg_depend d join pg_constraint c on c.oid=d.objid
        where d.classid='pg_constraint'::regclass
          and d.refclassid='pg_proc'::regclass and d.refobjid=p.oid
          and c.contype='c' and c.connamespace=${schema}::regnamespace
      ) as checked
    from pg_proc p
    where p.pronamespace=${schema}::regnamespace and starts_with(p.proname,'allrice_')
    order by p.oid`;
}

type FunctionCatalog = Awaited<ReturnType<typeof functionCatalog>>;

function requiredSearchPaths(catalog: FunctionCatalog) {
  // String-bodied SQL/PLpgSQL function calls are not recorded by pg_depend.
  // Follow conventional allrice_* identifiers from the real CHECK dependencies,
  // ignoring comments/literals and schema-qualified references.
  const references = new Map(
    catalog.map((row) => [
      row.oid,
      new Set(
        row.prosrc
          .replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, ' ')
          .replace(/"([a-z_][a-z0-9_]*)"/g, '$1')
          .replace(/\s*\.\s*/g, '.')
          .match(/(?<![\w.])\ballrice_[a-z0-9_]+\b/g) ?? [],
      ),
    ]),
  );
  const pending = catalog.filter((row) => row.checked);
  const visited = new Set<number>();
  const required = new Set<number>();
  while (pending.length) {
    const row = pending.pop()!;
    if (visited.has(row.oid)) continue;
    visited.add(row.oid);
    const names = references.get(row.oid)!;
    if ((row.checked && names.size) || names.has(row.proname))
      required.add(row.oid);
    pending.push(...catalog.filter((callee) => names.has(callee.proname)));
  }
  return catalog.filter((row) => required.has(row.oid));
}

function assertSearchPaths(catalog: FunctionCatalog, schema: string) {
  const expected = `search_path=pg_catalog, ${schema}`;
  for (const row of requiredSearchPaths(catalog))
    expect(row.proconfig ?? [], row.proname).toContain(expected);
  for (const row of catalog)
    for (const config of row.proconfig ?? [])
      if (config.startsWith('search_path='))
        expect(config, row.proname).toBe(expected);
}

function pgClient(
  command: 'pg_dump' | 'pg_restore' | 'psql',
  url: URL,
  args: string[],
  input?: Buffer,
) {
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
  const result = spawnSync(command, args, {
    env,
    input,
    timeout: 60_000,
    maxBuffer: 32 * 1024 ** 2,
  });
  if (result.error) throw result.error;
  return result;
}

suite('0225 function search_path and standard backup restore', () => {
  it.each(['custom', 'plain'] as const)(
    'restores CHECK-validated data from an unmodified %s dump after all migrations',
    async (format) => {
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
        const migrationNames = (await readdir(migrations))
          .filter((name) => name.endsWith('.sql'))
          .sort();
        await source.db.begin(async (tx) => {
          for (const name of migrationNames.filter(
            (name) => name < migrationName,
          ))
            await tx.unsafe(await readFile(new URL(name, migrations), 'utf8'));
        });
        // Copy the real CHECKs, including native_recurring_control_kind, while
        // leaving unrelated tenant FKs/triggers out of this backup regression.
        await source.db.unsafe(`
        create table restore_controls (like allrice_native_recurring_controls including defaults including constraints);
        create table restore_versions (like allrice_native_recurring_versions including defaults including constraints);
        create table restore_conversations (conversation_snapshot jsonb);
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
        const before = await functionCatalog(source.db, 'public');
        if (
          format === 'custom' &&
          requiredSearchPaths(before).some(
            (row) =>
              !row.proconfig?.some((value) => value.startsWith('search_path=')),
          )
        ) {
          const oldDump = pgClient('pg_dump', source.url, ['--format=custom']);
          expect(oldDump.status, oldDump.stderr.toString()).toBe(0);
          const broken = await database();
          const failed = pgClient(
            'pg_restore',
            broken.url,
            ['--exit-on-error', '--dbname', broken.url.pathname.slice(1)],
            oldDump.stdout,
          );
          expect(failed.status, failed.stderr.toString()).not.toBe(0);
          expect(failed.stderr.toString()).toMatch(
            /function allrice_.* does not exist/,
          );
        }
        const migration = await readFile(
          new URL(migrationName, migrations),
          'utf8',
        );
        await source.db.begin((tx) => tx.unsafe(migration));
        const after = await functionCatalog(source.db, 'public');
        expect(after.map((row) => row.definition)).toEqual(
          before.map((row) => row.definition),
        );
        const changed = after.filter(
          (row, index) =>
            JSON.stringify(row.proconfig) !==
            JSON.stringify(before[index]!.proconfig),
        );
        expect(changed.map((row) => row.oid)).toEqual(
          requiredSearchPaths(before)
            .filter(
              (row) =>
                !row.proconfig?.includes('search_path=pg_catalog, public'),
            )
            .map((row) => row.oid),
        );
        for (const row of changed) {
          const prior = before.find((item) => item.oid === row.oid)!;
          expect(row.proconfig).toEqual([
            ...(prior.proconfig ?? []).filter(
              (value) => !value.startsWith('search_path='),
            ),
            'search_path=pg_catalog, public',
          ]);
        }
        // Reapplying changes no definitions/configuration and leaves row values intact.
        await source.db.begin((tx) => tx.unsafe(migration));
        expect(await functionCatalog(source.db, 'public')).toEqual(after);
        // CREATE OR REPLACE without SET silently clears proconfig. Always check
        // the latest schema, so a later migration cannot invalidate the runbook.
        await source.db.begin(async (tx) => {
          for (const name of migrationNames.filter(
            (name) => name > migrationName,
          ))
            await tx.unsafe(await readFile(new URL(name, migrations), 'utf8'));
        });
        assertSearchPaths(await functionCatalog(source.db, 'public'), 'public');

        const dump = pgClient('pg_dump', source.url, [
          `--format=${format}`,
          '--no-owner',
          '--no-privileges',
        ]);
        expect(dump.status, dump.stderr.toString()).toBe(0);
        const path = join(
          root,
          format === 'custom' ? 'standard.dump' : 'standard.sql',
        );
        await writeFile(path, dump.stdout, { mode: 0o600 });
        const restored = await database();
        const result =
          format === 'custom'
            ? pgClient(
                'pg_restore',
                restored.url,
                ['--exit-on-error', '--dbname', restored.url.pathname.slice(1)],
                await readFile(path),
              )
            : pgClient(
                'psql',
                restored.url,
                ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
                await readFile(path),
              );
        expect(result.status, result.stderr.toString()).toBe(0);
        assertSearchPaths(
          await functionCatalog(restored.db, 'public'),
          'public',
        );
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
            await admin.unsafe(
              `drop database if exists "${name}" with (force)`,
            );
        } finally {
          await admin.end({ timeout: 5 });
          await rm(root, { recursive: true, force: true });
        }
      }
    },
    120_000,
  );

  it('pins CHECK and recursive functions to the isolated schema and detects configuration lost on redefinition', async () => {
    const f = await createRuntimeFixtureDatabase({ ownSchemaOnly: true });
    try {
      const [scope] = await f.db`select current_schema() as name`;
      const schema = scope!.name as string;
      const catalog = await functionCatalog(f.db, schema);
      assertSearchPaths(catalog, schema);
      await f.db.begin(async (tx) => {
        await tx.unsafe("set local search_path = ''");
        const [digest] = await tx.unsafe(
          `select "${schema}".allrice_native_control_canonical('{"b":[2,1],"a":0}') as value`,
        );
        expect(digest!.value).toBe('{"a":0,"b":[2,1]}');
      });
      // Reproduce the later-migration regression for every catalog-derived
      // entry point, including the unqualified self-recursive canonical helper.
      for (const row of requiredSearchPaths(catalog)) {
        const [definition] =
          await f.db`select pg_get_functiondef(${row.oid}::oid) as sql`;
        const original = definition!.sql as string;
        const withoutPath = original.replace(
          /^ SET search_path TO [^\n]*\n/m,
          '',
        );
        expect(withoutPath).not.toBe(original);
        await f.db.unsafe(withoutPath);
        const redefined = await functionCatalog(f.db, schema);
        expect(
          () => assertSearchPaths(redefined, schema),
          row.proname,
        ).toThrow();
        await f.db.unsafe(original);
      }
      assertSearchPaths(await functionCatalog(f.db, schema), schema);
    } finally {
      await f.close();
    }
  }, 60_000);
});
