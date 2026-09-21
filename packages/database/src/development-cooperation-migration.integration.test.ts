/** Additive 0100 -> 0101 on a UUID-owned schema with existing assistant data.
 * Does not migrate Dev/Prod or claim an old-binary downgrade is safe. */
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, it, expect, vi } from 'vitest';
import {
  assistantFixture,
  createAssistantFixtureDatabase,
} from './assistant-runtime.fixture.ts';
import { createAssistantRuntime } from './assistant-runtime.ts';
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET-144 incremental migration and fresh connection', () => {
  it('preserves existing Runs, assistant history and budgets while adding only empty development metadata', async () => {
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '1');
    const fixture = await createAssistantFixtureDatabase({
      throughMigration: '0100_tenant_scoped_resource_quotas.sql',
    });
    let fresh: ReturnType<typeof postgres> | undefined;
    try {
      const f = await assistantFixture(fixture.db);
      await f.delegate();
      const before = await f.runtime.getTree(f.context, {
        runId: f.task.runId,
      });
      const [scope] = await fixture.db<
        { schema: string }[]
      >`select current_schema() as schema`;
      const [old] =
        await fixture.db`select to_regclass('allrice_development_heads') as table_name`;
      expect(old!.table_name).toBeNull();
      await fixture.db.begin(async (tx) =>
        tx.unsafe(
          await readFile(
            new URL(
              '../migrations/0101_development_cooperation.sql',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
      const url = new URL(process.env.ALLRICE_TEST_DATABASE_URL!);
      url.searchParams.set('options', `-csearch_path=${scope!.schema}`);
      fresh = postgres(url.toString(), { max: 1, onnotice: () => {} });
      // Close the original pool: recovery must not depend on process-local state.
      await fixture.db.end({ timeout: 5 });
      const cold = createAssistantRuntime({
        database: fresh,
        authorize: async () => {},
      });
      expect(await cold.getTree(f.context, { runId: f.task.runId })).toEqual(
        before,
      );
      expect(await fresh`select * from allrice_development_heads`).toHaveLength(
        0,
      );
      expect(
        await fresh`select * from allrice_development_assignments`,
      ).toHaveLength(0);
      const schema = await fresh`select current_schemas(false) as names`;
      expect(schema[0]!.names).toEqual([scope!.schema]);
    } finally {
      await fresh?.end({ timeout: 5 });
      await fixture.close();
      vi.unstubAllEnvs();
    }
  }, 120000);
});
