/** Real isolated PG, synthetic account fingerprints, no provider/credential I/O. */
import type {
  CodexProviderStatus,
  CodexSubscriptionQuotaSnapshot,
} from '@allrice/contracts';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { createAssistantFixtureDatabase } from '../assistant-runtime.fixture.ts';
import { getCodexProviderStatus, recordCodexProviderStatus } from './status.ts';
// Pure normalization/admission only: never construct or start the broker/client.
import { codexQuotaObservation } from '../../../../apps/worker/src/codex-auth-broker.ts';
import { assertSubscriptionQuotaNotExhausted } from '../../../../apps/worker/src/subscription-quota-admission.ts';

const state = vi.hoisted(() => ({
  database: undefined as
    Awaited<ReturnType<typeof createAssistantFixtureDatabase>> | undefined,
}));
vi.mock('../core/client.ts', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getDatabase: () => {
    if (!state.database) throw Error('isolated_test_database_not_initialized');
    return state.database.db;
  },
}));
const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const accountA = `sha256:${'a'.repeat(64)}`;
const accountB = `sha256:${'b'.repeat(64)}`;
const time = (n: number) =>
  new Date(Date.parse('2030-01-01T00:00:00Z') + n * 1000).toISOString();
function quota(
  at: number,
  usedPercent: number,
  accountFingerprint = accountA,
): CodexSubscriptionQuotaSnapshot {
  return {
    source: 'codex_app_server',
    status: 'available',
    checkedAt: time(at),
    accountFingerprint,
    detailCode: 'codex_quota_read',
    buckets: [
      {
        limitId: 'codex',
        limitReached: usedPercent === 100,
        windows: [
          {
            slot: 'primary',
            status: 'available',
            usedPercent,
            windowDurationMins: 300,
            resetsAt: 2_000_000_000,
          },
          {
            slot: 'secondary',
            status: 'unknown',
            usedPercent: null,
            windowDurationMins: null,
            resetsAt: null,
          },
        ],
      },
    ],
  };
}
function status(
  probeAt: number,
  snapshot?: CodexSubscriptionQuotaSnapshot | null,
): CodexProviderStatus {
  return {
    provider: 'codex',
    authMode: 'chatgpt_subscription',
    status: 'connected',
    cliVersion: 'synthetic-dsh',
    detailCode: `synthetic_probe_${probeAt}`,
    checkedAt: time(probeAt),
    ...(snapshot === undefined ? {} : { quota: snapshot }),
  };
}

integration('Codex quota status write ordering (isolated PG)', () => {
  let database: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    database = await createAssistantFixtureDatabase();
    state.database = database;
  }, 120_000);
  beforeEach(async () => {
    // Only the fixture's generated schema, never an application provider row.
    await database.db`delete from allrice_provider_status where provider = 'codex'`;
  });
  afterAll(async () => {
    try {
      if (database)
        expect(await database.close()).toMatchObject({
          schemaRemoved: true,
          storageRemoved: true,
          databaseClosed: true,
          adminClosed: true,
        });
    } finally {
      state.database = undefined;
    }
  });

  it('old available and duplicate timestamp cannot overwrite newer exhausted', async () => {
    await recordCodexProviderStatus(status(1, quota(3, 20)));
    await recordCodexProviderStatus(status(2, quota(6, 100)));
    await recordCodexProviderStatus(status(1, quota(3, 20)));
    await recordCodexProviderStatus(status(4, quota(5, 20)));
    await recordCodexProviderStatus(status(4, quota(6, 20)));
    const current = await getCodexProviderStatus();
    expect(current.quota).toEqual(quota(6, 100));
    expect(current.checkedAt).toBe(time(4));
  });

  it('an older started probe cannot replace a newer started probe even if it finishes late', async () => {
    await recordCodexProviderStatus(status(3, quota(5, 20)));
    await recordCodexProviderStatus(status(2, quota(6, 100)));
    const current = await getCodexProviderStatus();
    expect(current.quota).toEqual(quota(5, 20));
    expect(current.checkedAt).toBe(time(3));
    expect(current.detailCode).toBe('synthetic_probe_3');
  });

  it('concurrent updates atomically retain the newest same-account quota', async () => {
    await recordCodexProviderStatus(status(0, quota(50, 0)));
    const observations = Array.from({ length: 20 }, (_, index) => index + 1);
    await Promise.all(
      observations
        .reverse()
        .map((index) =>
          recordCodexProviderStatus(
            status(index, quota(100 + index, index === 20 ? 100 : index)),
          ),
        ),
    );
    const current = await getCodexProviderStatus();
    expect(current.quota).toEqual(quota(120, 100));
    expect(current.checkedAt).toBe(time(20));
  });

  it('account changes order by probe identity epoch, not old-account completion', async () => {
    await recordCodexProviderStatus(status(1, quota(40, 20, accountA)));
    await recordCodexProviderStatus(status(2, quota(30, 100, accountB)));
    await recordCodexProviderStatus(status(1, quota(50, 20, accountA)));
    const current = await getCodexProviderStatus();
    expect(current.quota).toEqual(quota(30, 100, accountB));
    expect(current.checkedAt).toBe(time(2));
  });

  it('a newer clear fences old/equal-start in-flight reads, even with later completion', async () => {
    await recordCodexProviderStatus(status(1, quota(40, 100)));
    await recordCodexProviderStatus(status(2, null));
    await recordCodexProviderStatus(status(1, quota(50, 20)));
    await recordCodexProviderStatus(status(2, quota(51, 20)));
    expect((await getCodexProviderStatus()).quota).toBeNull();
    await recordCodexProviderStatus(status(3, quota(52, 15, accountB)));
    expect((await getCodexProviderStatus()).quota).toEqual(
      quota(52, 15, accountB),
    );
  });

  it('missing quota preserves prior observation; old/equal-start clears do not remove it', async () => {
    await recordCodexProviderStatus(status(1, quota(2, 100)));
    await recordCodexProviderStatus(status(4));
    await recordCodexProviderStatus(status(3, null));
    await recordCodexProviderStatus(status(4, null));
    const current = await getCodexProviderStatus();
    expect(current.quota).toEqual(quota(2, 100));
    expect(current.checkedAt).toBe(time(4));
  });

  it('unknown account observation invalidates the old account and fences its late reply', async () => {
    await recordCodexProviderStatus(status(1, quota(2, 20)));
    const unknown: CodexSubscriptionQuotaSnapshot = {
      source: 'codex_app_server',
      status: 'unknown',
      checkedAt: time(5),
      accountFingerprint: null,
      detailCode: 'codex_quota_authorization_required',
      buckets: [],
    };
    await recordCodexProviderStatus(status(3, unknown));
    await recordCodexProviderStatus(status(1, quota(7, 20)));
    expect((await getCodexProviderStatus()).quota).toEqual(unknown);
  });

  it('first clear is durable and rejects older completed data', async () => {
    await recordCodexProviderStatus(status(5, null));
    await recordCodexProviderStatus(status(1, quota(6, 20)));
    expect((await getCodexProviderStatus()).quota).toBeNull();
  });

  it('preserves unreset exhaustion through error, rejects an older started available, then accepts authoritative fresh data', async () => {
    const exhausted = quota(2, 100);
    await recordCodexProviderStatus(status(1, exhausted));
    const error: CodexSubscriptionQuotaSnapshot = {
      ...exhausted,
      status: 'error',
      checkedAt: time(4),
      detailCode: 'codex_quota_rpc_failed',
      buckets: [],
    };
    await recordCodexProviderStatus(status(3, error));
    expect((await getCodexProviderStatus()).quota).toEqual(exhausted);
    expect((await getCodexProviderStatus()).checkedAt).toBe(time(3));
    await recordCodexProviderStatus(status(2, quota(5, 20)));
    expect((await getCodexProviderStatus()).quota).toEqual(exhausted);
    await recordCodexProviderStatus(status(4, quota(6, 20)));
    expect((await getCodexProviderStatus()).quota).toEqual(quota(6, 20));
  });

  it('broker transport/schema failures remain error observations and cannot clear unreset exhaustion or admission', async () => {
    const now = Date.now();
    const at = (seconds: number) =>
      new Date(now + seconds * 1000).toISOString();
    const exhausted = quota(2, 100);
    exhausted.checkedAt = at(-20);
    exhausted.buckets[0]!.windows[0].resetsAt = Math.floor(now / 1000) + 3600;
    await recordCodexProviderStatus({
      ...status(1, exhausted),
      checkedAt: at(-21),
    });

    // RPC catch returns null; malformed RPC data fails the snapshot schema.
    for (const [index, raw] of [null, { status: 'available' }].entries()) {
      const observation = codexQuotaObservation(raw, true);
      expect(observation).toMatchObject({
        status: 'error',
        accountFingerprint: null,
        detailCode: 'codex_quota_protocol_unavailable',
        buckets: [],
      });
      const startedAt = at(-10 + index);
      await recordCodexProviderStatus({
        ...status(3, observation),
        checkedAt: startedAt,
      });
      const persisted = await getCodexProviderStatus();
      expect(persisted.quota).toEqual(exhausted);
      expect(persisted.quota?.checkedAt).toBe(at(-20));
      expect(persisted.checkedAt).toBe(startedAt);
      expect(() =>
        assertSubscriptionQuotaNotExhausted(persisted.quota, now),
      ).toThrow(
        expect.objectContaining({
          code: 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED',
        }),
      );
    }

    // The newer failed probe also fences a delayed older available result.
    await recordCodexProviderStatus({
      ...status(2, { ...quota(5, 20), checkedAt: at(1) }),
      checkedAt: at(-15),
    });
    const persisted = await getCodexProviderStatus();
    expect(persisted.quota).toEqual(exhausted);
    expect(persisted.checkedAt).toBe(at(-9));
  });

  it('unknown identity or available data for only another bucket cannot erase the exhausted window', async () => {
    const exhausted = quota(2, 100);
    await recordCodexProviderStatus(status(1, exhausted));
    await recordCodexProviderStatus(
      status(3, {
        ...exhausted,
        status: 'unknown',
        checkedAt: time(4),
        accountFingerprint: null,
        buckets: [],
      }),
    );
    expect((await getCodexProviderStatus()).quota).toEqual(exhausted);
    const unrelated = quota(6, 20);
    unrelated.buckets[0]!.limitId = 'another_meter';
    await recordCodexProviderStatus(status(5, unrelated));
    expect((await getCodexProviderStatus()).quota).toEqual(exhausted);
    const missingWindow = quota(8, 20);
    missingWindow.buckets[0]!.windows[1] = {
      ...missingWindow.buckets[0]!.windows[0],
      slot: 'secondary',
    };
    missingWindow.buckets[0]!.windows[0] = {
      slot: 'primary',
      status: 'unknown',
      usedPercent: null,
      resetsAt: null,
      windowDurationMins: null,
    };
    await recordCodexProviderStatus(status(7, missingWindow));
    expect((await getCodexProviderStatus()).quota).toEqual(exhausted);
  });

  it('explicit new account or disconnected state invalidates retained old-account exhaustion', async () => {
    await recordCodexProviderStatus(status(1, quota(2, 100)));
    await recordCodexProviderStatus(status(3, quota(4, 20, accountB)));
    expect((await getCodexProviderStatus()).quota).toEqual(
      quota(4, 20, accountB),
    );
    await recordCodexProviderStatus(status(2, quota(6, 100)));
    expect((await getCodexProviderStatus()).quota).toEqual(
      quota(4, 20, accountB),
    );
    await recordCodexProviderStatus({ ...status(5), status: 'disconnected' });
    expect((await getCodexProviderStatus()).quota).toBeNull();
  });

  it('after the known reset, error becomes unknown rather than retaining or inventing capacity', async () => {
    const exhausted = quota(2, 100);
    exhausted.buckets[0]!.windows[0].resetsAt = 1;
    await recordCodexProviderStatus(status(1, exhausted));
    const error: CodexSubscriptionQuotaSnapshot = {
      ...exhausted,
      status: 'error',
      checkedAt: time(4),
      buckets: [],
    };
    await recordCodexProviderStatus(status(3, error));
    expect((await getCodexProviderStatus()).quota).toEqual(error);
  });

  it('retains a fresh explicit limitReached without percent until same-bucket authoritative clear', async () => {
    const base = Date.now() - 30_000;
    const at = (n: number) => new Date(base + n * 1000).toISOString();
    const explicit = quota(2, 0);
    explicit.status = 'unknown';
    explicit.checkedAt = at(2);
    explicit.buckets[0]!.limitReached = true;
    for (const window of explicit.buckets[0]!.windows) {
      window.status = 'unknown';
      window.usedPercent = null;
      window.windowDurationMins = null;
      window.resetsAt = null;
    }
    await recordCodexProviderStatus({
      ...status(1, explicit),
      checkedAt: at(1),
    });
    const error: CodexSubscriptionQuotaSnapshot = {
      ...explicit,
      status: 'error',
      checkedAt: at(4),
      buckets: [],
    };
    await recordCodexProviderStatus({ ...status(3, error), checkedAt: at(3) });
    expect((await getCodexProviderStatus()).quota).toEqual(explicit);
    const incompleteClear = quota(6, 20);
    incompleteClear.checkedAt = at(6);
    incompleteClear.buckets[0]!.limitReached = null;
    await recordCodexProviderStatus({
      ...status(5, incompleteClear),
      checkedAt: at(5),
    });
    expect((await getCodexProviderStatus()).quota).toEqual(explicit);
    const clear = quota(8, 20);
    clear.checkedAt = at(8);
    await recordCodexProviderStatus({ ...status(7, clear), checkedAt: at(7) });
    expect((await getCodexProviderStatus()).quota).toEqual(clear);
  });

  it('does not extend an unwindowed explicit limit beyond its own freshness period', async () => {
    const explicit = quota(2, 20);
    explicit.checkedAt = new Date(Date.now() - 600_000).toISOString();
    explicit.buckets[0]!.limitReached = true;
    await recordCodexProviderStatus(status(1, explicit));
    const error: CodexSubscriptionQuotaSnapshot = {
      ...explicit,
      status: 'error',
      checkedAt: new Date().toISOString(),
      buckets: [],
    };
    await recordCodexProviderStatus(status(3, error));
    expect((await getCodexProviderStatus()).quota).toEqual(error);
  });
});
