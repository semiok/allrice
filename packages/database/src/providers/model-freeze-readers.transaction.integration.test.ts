import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import * as client from '../core/client.ts';
import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { readPlatformModelSettings } from './platform-model-settings.ts';
import {
  readEnabledCodexSubscription,
  requireEnabledCodexSubscription,
} from './codex-subscriptions.ts';

// These PostgreSQL checks exercise the two shared readers. Full model-freeze
// chains are covered separately in model-freeze-chain.transaction.integration.test.ts.
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

integration('model freeze reader prerequisites: isolated PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  let schema: string;

  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    const [scope] = await fixture.db<
      {
        schema: string;
        settings_schema: string;
        subscriptions_schema: string;
      }[]
    >`select current_schema() as schema,
      (select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.oid=to_regclass('allrice_platform_model_settings')) as settings_schema,
      (select n.nspname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where c.oid=to_regclass('allrice_codex_subscriptions')) as subscriptions_schema`;
    if (!scope || !/^p25_[a-f0-9]{32}$/.test(scope.schema)) {
      throw Error('owned_fixture_schema_required');
    }
    expect(scope.settings_schema).toBe(scope.schema);
    expect(scope.subscriptions_schema).toBe(scope.schema);
    schema = scope.schema;
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await fixture?.close();
  }, 30_000);

  function forbidPool() {
    return vi.spyOn(client, 'getDatabase').mockImplementation(() => {
      throw Error('unexpected_global_database');
    });
  }

  it('sees its own settings change while an observer sees committed state', async () => {
    const before = await readPlatformModelSettings(fixture.db);
    const configuration = {
      ...before.configuration,
      timeoutMs: before.configuration.timeoutMs === 600_000 ? 300_000 : 600_000,
    };
    const rollback = Error('intentional_settings_fixture_rollback');
    const pool = forbidPool();
    await expect(
      fixture.db.begin(async (tx) => {
        await tx`select set_config('search_path', ${schema}, true)`;
        const [inside] = await tx<{ pid: number }[]>`
          select pg_backend_pid() as pid`;
        await tx`update allrice_platform_model_settings
          set configuration=${tx.json(configuration)}, revision=revision+1
          where singleton`;
        expect(await readPlatformModelSettings(tx)).toMatchObject({
          revision: before.revision + 1,
          configuration,
        });
        const [observer] = await fixture.db<{ pid: number }[]>`
          select pg_backend_pid() as pid`;
        if (!inside || !observer) throw Error('backend_pid_missing');
        expect(observer.pid).not.toBe(inside.pid);
        expect(await readPlatformModelSettings(fixture.db)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await readPlatformModelSettings(fixture.db)).toEqual(before);
    expect(pool).not.toHaveBeenCalled();
  }, 15_000);

  it('reads uncommitted subscription changes and restores state on rollback', async () => {
    await fixture.db.begin(async (tx) => {
      await tx`select set_config('search_path', ${schema}, true)`;
      await tx`update allrice_codex_subscriptions set enabled=false`;
      await tx`update allrice_codex_subscriptions set enabled=true where slot=1`;
    });
    const rollback = Error('intentional_subscription_fixture_rollback');
    const pool = forbidPool();
    await expect(
      fixture.db.begin(async (tx) => {
        await tx`select set_config('search_path', ${schema}, true)`;
        await tx`update allrice_codex_subscriptions set enabled=false`;
        expect(await readEnabledCodexSubscription(tx)).toBeNull();
        await expect(requireEnabledCodexSubscription(tx)).rejects.toMatchObject(
          { code: 'disabled' },
        );
        expect(await requireEnabledCodexSubscription(fixture.db)).toBe(1);
        await tx`update allrice_codex_subscriptions set enabled=true where slot=2`;
        expect(await requireEnabledCodexSubscription(tx)).toBe(2);
        expect(await requireEnabledCodexSubscription(fixture.db)).toBe(1);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await requireEnabledCodexSubscription(fixture.db)).toBe(1);
    expect(pool).not.toHaveBeenCalled();
  }, 15_000);
});
