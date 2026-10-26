import type postgres from 'postgres';
import { queueStopCause } from './policy.ts';

type Sql = postgres.Sql;
type TransactionSql = postgres.TransactionSql;

/**
 * MET-210 #4. Worker lease transactions (heartbeat, event write, usage
 * settlement) contend for one runtime root. A lock wait past lock_timeout
 * (55P03) used to end the whole Run at once. These helpers name each failed
 * attempt (site, SQLSTATE, Run/Job, backend PID, timings) and let heartbeat and
 * event writes retry such a rolled-back attempt, but only inside the lease the
 * database itself still shows as current.
 */
export type LeaseTransactionSite =
  'job_heartbeat' | 'job_event' | 'usage_settlement';

type LeaseTransactionOutcome =
  /** Rolled back (55P03); the whole transaction runs again from a fresh start. */
  | 'retrying'
  /** Rolled back; no attempt or lease time left for another. */
  | 'exhausted'
  /** Rolled back; the database shows the lease expired or replaced. */
  | 'lease_lost'
  /** Rolled back; a stop (cancel/timeout/drain) is due, so no retry. */
  | 'stopped'
  /** Any other database or driver failure; never retried here. */
  | 'failed';

/** The lock wait every lease transaction allows before PostgreSQL rolls it back. */
export const leaseLockWaitMs = 5_000;
/** A retry's lock deadline stays this far ahead of the lease end, leaving time
 * for its remaining statements and, if it still fails, the Worker's abort. */
const leaseRetryReserveMs = 1_500;
const minimumRetryLockWaitMs = 500;
const maxLeaseLockAttempts = 4;

const counts = new Map<string, number>();

/** PostgreSQL SQLSTATE, or a postgres.js driver code such as CONNECTION_CLOSED.
 * Application codes (lease_lost, conflict, ...) are lowercase and excluded. */
export function databaseErrorCode(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = error.code;
  return typeof code === 'string' &&
    (/^[0-9A-Z]{5}$/.test(code) || /^[A-Z][A-Z_]{2,39}$/.test(code))
    ? code
    : null;
}

/** IDs, codes and timings only: never SQL text, parameters or error messages. */
function recordLeaseTransactionFailure(event: {
  site: LeaseTransactionSite;
  sqlState: string;
  runId: string | null;
  jobId: string;
  backendPid: number | null;
  connectionMs: number | null;
  durationMs: number;
  attempt: number;
  outcome: LeaseTransactionOutcome;
}) {
  const key = `${event.site}:${event.sqlState}:${event.outcome}`;
  const count = (counts.get(key) ?? 0) + 1;
  counts.set(key, count);
  (event.outcome === 'retrying' ? console.warn : console.error)(
    '[MET-210] Worker lease transaction rolled back',
    { ...event, processCount: count },
  );
}

/** One transaction attempt: which backend ran it and how long it lasted. */
export class LeaseTransactionTrace {
  private readonly started = performance.now();
  private backendPid: number | null = null;
  private runId: string | null = null;
  private connectionMs: number | null = null;

  constructor(
    private readonly site: LeaseTransactionSite,
    private readonly jobId: string,
  ) {}

  /** Call as the attempt's first statement, before it can wait on any lock. */
  async begin(tx: TransactionSql) {
    const [row] = await tx<{ pid: number; run_id: string | null }[]>`
      select pg_backend_pid() pid,(select run_id from allrice_jobs where id=${this.jobId}) run_id`;
    this.backendPid = row?.pid ?? null;
    this.runId = row?.run_id ?? null;
    this.connectionMs = Math.round(performance.now() - this.started);
  }

  record(error: unknown, attempt: number, outcome: LeaseTransactionOutcome) {
    const sqlState = databaseErrorCode(error);
    if (!sqlState) return;
    recordLeaseTransactionFailure({
      site: this.site,
      sqlState,
      runId: this.runId,
      jobId: this.jobId,
      backendPid: this.backendPid,
      connectionMs: this.connectionMs,
      durationMs: Math.round(performance.now() - this.started),
      attempt,
      outcome,
    });
  }
}

/** A single traced attempt; failures are recorded, never retried. */
export async function tracedLeaseTransaction<T>(
  sql: Sql,
  site: LeaseTransactionSite,
  jobId: string,
  run: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const trace = new LeaseTransactionTrace(site, jobId);
  try {
    return (await sql.begin(async (tx) => {
      await trace.begin(tx);
      return run(tx);
    })) as T;
  } catch (error) {
    trace.record(error, 1, 'failed');
    throw error;
  }
}

export interface LeaseIdentity {
  workerId: string;
  jobId: string;
  leaseToken: string;
}

/** Lock wait for the next attempt, read without locks against the database
 * clock. The last committed lease bounds it; nothing here extends that lease. */
async function nextLeaseLockWait(
  sql: Sql,
  lease: LeaseIdentity,
  mode: 'stop' | 'receipt',
) {
  const [job] = await sql<
    {
      status: string;
      worker_id: string | null;
      lease_token: string | null;
      lease_expires_at: Date | null;
      drain_deadline_at: Date | null;
      drain_reason: 'cancel' | 'timeout' | null;
      cancel_requested_at: Date | null;
      timeout_at: Date;
      now: Date;
    }[]
  >`select status,worker_id,lease_token,lease_expires_at,drain_deadline_at,drain_reason,
      cancel_requested_at,timeout_at,clock_timestamp() now
    from allrice_jobs where id=${lease.jobId}`;
  if (
    !job ||
    job.status !== 'running' ||
    job.worker_id !== lease.workerId ||
    job.lease_token !== lease.leaseToken ||
    !job.lease_expires_at ||
    job.lease_expires_at <= job.now ||
    (job.drain_deadline_at && job.drain_deadline_at <= job.now)
  )
    return 'lease_lost' as const;
  if (mode === 'stop' && queueStopCause(job, job.now))
    return 'stopped' as const;
  const end = Math.min(
    job.lease_expires_at.getTime(),
    job.drain_deadline_at?.getTime() ?? Infinity,
  );
  const wait = Math.min(
    leaseLockWaitMs,
    end - job.now.getTime() - leaseRetryReserveMs,
  );
  return wait >= minimumRetryLockWaitMs ? wait : ('exhausted' as const);
}

/** Runs `run` once, and again only after a 55P03 rollback while the database
 * still shows this incarnation's unexpired lease (and, for `stop`, no requested
 * stop). Each attempt is a whole fresh transaction, so every queue, cancel and
 * authority check runs again; the handler itself is never re-entered. */
export async function retryLeaseLockTimeout<T>(input: {
  sql: Sql;
  site: LeaseTransactionSite;
  lease: LeaseIdentity;
  /** `stop`: any requested stop ends the retries (heartbeat). `receipt`: writes
   * keep the drain window that lockedLeasedJob itself still accepts. */
  mode: 'stop' | 'receipt';
  leaseLost: () => Error;
  signal?: AbortSignal;
  run: (trace: LeaseTransactionTrace, lockWaitMs: number) => Promise<T>;
}): Promise<T> {
  let lockWaitMs = leaseLockWaitMs;
  for (let attempt = 1; ; attempt++) {
    const trace = new LeaseTransactionTrace(input.site, input.lease.jobId);
    try {
      return await input.run(trace, lockWaitMs);
    } catch (error) {
      // A 55P03 response, from any statement or from COMMIT, means PostgreSQL
      // rolled this transaction back. A dropped connection or failed ROLLBACK
      // surfaces a different error: its outcome is unconfirmed, never retried.
      if (databaseErrorCode(error) !== '55P03') {
        trace.record(error, attempt, 'failed');
        throw error;
      }
      if (attempt < maxLeaseLockAttempts && !input.signal?.aborted)
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      const next =
        attempt >= maxLeaseLockAttempts || input.signal?.aborted
          ? ('exhausted' as const)
          : await nextLeaseLockWait(input.sql, input.lease, input.mode);
      trace.record(
        error,
        attempt,
        typeof next === 'number' ? 'retrying' : next,
      );
      if (next === 'lease_lost') throw input.leaseLost();
      if (typeof next !== 'number') throw error;
      lockWaitMs = next;
    }
  }
}
