/**
 * MET-210 #4 observation counters. The 40P01/40001 retries stay for now, but
 * every rolled-back attempt is counted and logged under one tag, so the Dev
 * observation period can tell whether removing read-path row locks stopped
 * them. Delete the retries (and this module) once they no longer fire.
 */
export type TransactionRetryOutcome =
  /** Rolled back; the whole transaction runs again from a fresh start. */
  | 'retrying'
  /** Rolled back on the last allowed attempt; the SQLSTATE is rethrown. */
  | 'exhausted'
  /** Rolled back and returned as a settled failure for the caller to retry. */
  | 'rollback_receipt';

const counts = new Map<string, number>();

export function recordTransactionRetry(event: {
  site: string;
  sqlState: string;
  attempt: number;
  outcome: TransactionRetryOutcome;
}) {
  const key = `${event.site}:${event.sqlState}:${event.outcome}`;
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  console.warn('[TransactionRetry] PostgreSQL rolled back a transaction', {
    ...event,
    processCount: count,
  });
}

/** Per-process totals keyed by `site:sqlState:outcome`. */
export function transactionRetryCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}
