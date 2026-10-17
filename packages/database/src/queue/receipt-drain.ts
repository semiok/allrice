import type postgres from 'postgres';
import type { JobRow } from './row-mappers.ts';
import { leaseDeadline } from './policy.ts';
type TransactionSql = postgres.TransactionSql;
const receiptDrainMs = 30_000;

/** Freeze admission and a single deadline, under the caller's root -> clock -> job locks.
 * No native operation or user grant is performed in this transaction. */
export async function freezeJobReceiptDrain(
  transaction: TransactionSql,
  job: JobRow,
  cause: 'cancel' | 'timeout',
  leaseMs?: number,
) {
  const [clock] = await transaction<
    { now: Date }[]
  >`select clock_timestamp() as now`;
  const now = clock!.now;
  if (
    job.status !== 'running' ||
    !job.worker_id ||
    !job.lease_token ||
    !job.lease_expires_at ||
    job.lease_expires_at <= now
  )
    return null;
  const frozenCause = job.drain_reason ?? cause;
  const anchor =
    frozenCause === 'cancel'
      ? (job.cancel_requested_at ?? now)
      : job.timeout_at;
  const deadline =
    job.drain_deadline_at ?? new Date(anchor.getTime() + receiptDrainMs);
  const lease = new Date(
    Math.min(
      deadline.getTime(),
      leaseMs === undefined
        ? job.lease_expires_at.getTime()
        : leaseDeadline(leaseMs, now).getTime(),
    ),
  );
  await transaction`update allrice_jobs set drain_reason=${frozenCause},drain_deadline_at=${deadline},
    cancel_requested_at=coalesce(cancel_requested_at,${now}),
    cancel_reason=coalesce(cancel_reason,${frozenCause === 'timeout' ? 'job_timeout' : 'user_requested'}),
    lease_expires_at=${lease},updated_at=${now}
    where id=${job.id}`;
  return deadline > now && lease > now ? deadline : null;
}
