import postgres from 'postgres';

import { getDatabase } from '../core/client.ts';

/** Channel announcing that a committed job becomes claimable (MET-223). The
 * payload is the job's `available_at` in epoch milliseconds, or empty for
 * "now". Delivery is only a latency hint: the Worker's interval tick stays the
 * correctness path, so a lost announcement costs at most one poll interval,
 * never a job. */
export const JOB_READY_CHANNEL = 'allrice_job_ready';

/** Queue the announcement inside the transaction that makes the job claimable.
 * PostgreSQL sends it at commit and drops it on rollback, so a Worker woken by
 * it never scans before the row is visible. */
export async function notifyJobReady(
  transaction: postgres.TransactionSql,
  availableAt?: Date,
) {
  await transaction`select pg_notify(${JOB_READY_CHANNEL}, ${availableAt ? String(availableAt.getTime()) : ''})`;
}

/** LISTEN on a dedicated connection owned by the caller. postgres.js re-listens
 * after a drop and runs `onListen` again, which is when missed announcements
 * must be swept; owning the connection also lets the caller close a silently
 * stalled socket and start over. `connect_timeout` stops covering the LISTEN
 * once the handshake is done, so the whole subscription is bounded here and
 * abortable by a stopping Worker. */
export async function listenForReadyJobs(
  onReady: (payload: string) => void,
  onListen: () => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const subscriber = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    fetch_types: false,
    connection: { application_name: 'allrice-worker-wakeup' },
  });
  const close = () => subscriber.end({ timeout: 0 });
  let abandoned: string | undefined;
  const abandon = (reason: string) => {
    abandoned ??= reason;
    void close();
  };
  const timer = setTimeout(
    () => abandon('LISTEN timed out'),
    options.timeoutMs ?? 10_000,
  );
  const onAbort = () => abandon('LISTEN aborted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const { state } = await subscriber.listen(
      JOB_READY_CHANNEL,
      onReady,
      onListen,
    );
    if (abandoned) throw new Error(abandoned);
    return {
      /** Live backend pid of the LISTEN connection; changes on reconnect. */
      pid: (): number | null => state.pid || null,
      close,
    };
  } catch (error) {
    await close();
    throw abandoned ? new Error(abandoned) : error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Round trip proving the subscription still receives announcements. */
export async function probeReadyJobs(payload: string) {
  await getDatabase()`select pg_notify(${JOB_READY_CHANNEL}, ${payload})`;
}
