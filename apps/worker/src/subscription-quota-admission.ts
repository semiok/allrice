import { CodexSubscriptionQuotaSnapshotSchema } from '@allrice/contracts';
import { HandlerError } from './errors.js';

/** An allowance observation, not a lease on upstream capacity. Unknown/stale
 * readings do not invent remaining quota; bounded local admission still applies.
 * This function never buys credits, changes accounts or retries model requests. */
export function subscriptionQuotaState(raw: unknown, now = Date.now()) {
  const parsed = CodexSubscriptionQuotaSnapshotSchema.safeParse(raw);
  if (!parsed.success) return 'unknown' as const;
  const quota = parsed.data;
  const age = now - Date.parse(quota.checkedAt);
  if (!quota.accountFingerprint || age < -5_000 || quota.status === 'error')
    return 'unknown' as const;
  for (const bucket of quota.buckets) {
    const known = bucket.windows.filter(
      (window) => window.status === 'available',
    );
    if (
      known.some(
        (window) => window.usedPercent === 100 && window.resetsAt! * 1000 > now,
      )
    )
      return 'exhausted' as const;
    // A server-classified limit can exist without a fully described window.
    // Do not turn it into available simply because one window has reset.
    if (bucket.limitReached === true && age <= 300_000)
      return 'exhausted' as const;
  }
  if (
    age > 300_000 ||
    quota.status !== 'available' ||
    quota.buckets.some((bucket) =>
      bucket.windows.some(
        (window) =>
          window.status !== 'available' || window.resetsAt! * 1000 <= now,
      ),
    )
  )
    return 'unknown' as const;
  return 'available' as const;
}

export function assertSubscriptionQuotaNotExhausted(
  raw: unknown,
  now = Date.now(),
) {
  const state = subscriptionQuotaState(raw, now);
  if (state === 'exhausted')
    throw new HandlerError(
      'CODEX_SUBSCRIPTION_QUOTA_EXHAUSTED',
      'Codex 订阅额度已耗尽，已暂停新的模型调用；请查看额度重置时间。',
      false,
    );
  return state;
}
