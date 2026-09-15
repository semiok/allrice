import { describe, expect, it } from 'vitest';
import type { CodexSubscriptionQuotaSnapshot } from '@allrice/contracts';
import {
  assertSubscriptionQuotaNotExhausted,
  subscriptionQuotaState,
} from './subscription-quota-admission.js';

const now = Date.parse('2026-09-15T02:00:00Z');
function snapshot(): CodexSubscriptionQuotaSnapshot {
  return {
    source: 'codex_app_server',
    status: 'available',
    checkedAt: new Date(now).toISOString(),
    accountFingerprint: `sha256:${'a'.repeat(64)}`,
    detailCode: 'codex_quota_available',
    buckets: [
      {
        limitId: 'codex',
        limitReached: false,
        windows: [
          {
            slot: 'primary',
            status: 'available',
            usedPercent: 20,
            windowDurationMins: 300,
            resetsAt: now / 1000 + 5000,
          },
          {
            slot: 'secondary',
            status: 'available',
            usedPercent: 40,
            windowDurationMins: 10080,
            resetsAt: now / 1000 + 500000,
          },
        ],
      },
    ],
  };
}
describe('shared Codex allowance observations', () => {
  it('does not convert missing data into unlimited quota', () => {
    expect(assertSubscriptionQuotaNotExhausted(null, now)).toBe('unknown');
    expect(
      subscriptionQuotaState(
        { ...snapshot(), accessToken: 'never-accepted' },
        now,
      ),
    ).toBe('unknown');
  });
  it('admits a fresh measured snapshot without consuming or resetting allowance', () => {
    expect(assertSubscriptionQuotaNotExhausted(snapshot(), now)).toBe(
      'available',
    );
  });
  it.each([0, 1])('blocks exhaustion of actual window %i', (index) => {
    const quota = snapshot();
    quota.buckets[0]!.windows[index]!.usedPercent = 100;
    expect(() => assertSubscriptionQuotaNotExhausted(quota, now)).toThrow(
      expect.objectContaining({
        code: 'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED',
        retryable: false,
      }),
    );
  });
  it('retains a known exhausted window until its reset even after the cache ages', () => {
    const quota = snapshot();
    quota.checkedAt = new Date(now - 600000).toISOString();
    quota.buckets[0]!.windows[1].usedPercent = 100;
    expect(subscriptionQuotaState(quota, now)).toBe('exhausted');
  });
  it('does not assume a reset replenished the account without a fresh read', () => {
    const quota = snapshot();
    quota.buckets[0]!.windows[0].usedPercent = 100;
    quota.buckets[0]!.windows[0].resetsAt = now / 1000 - 1;
    expect(subscriptionQuotaState(quota, now)).toBe('unknown');
  });
  it('honors an explicit server-classified exhausted bucket', () => {
    const quota = snapshot();
    quota.buckets[0]!.limitReached = true;
    expect(subscriptionQuotaState(quota, now)).toBe('exhausted');
  });
  it('treats stale available, future-dated or unbound snapshots as unknown', () => {
    expect(
      subscriptionQuotaState(
        { ...snapshot(), checkedAt: new Date(now - 300001).toISOString() },
        now,
      ),
    ).toBe('unknown');
    expect(
      subscriptionQuotaState(
        { ...snapshot(), checkedAt: new Date(now + 60000).toISOString() },
        now,
      ),
    ).toBe('unknown');
    expect(
      subscriptionQuotaState({ ...snapshot(), accountFingerprint: null }, now),
    ).toBe('unknown');
  });
});
