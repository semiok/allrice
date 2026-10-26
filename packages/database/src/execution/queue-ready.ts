import { connect, type Socket } from 'node:net';
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
  // Own the socket (postgres.js's documented `socket` option, untyped in
  // 3.4.9): end() only half-closes it, so a peer that never answers would keep
  // it open and every recycle would leak one.
  const sockets = new Set<Socket>();
  const subscriberOptions = {
    max: 1,
    connect_timeout: 5,
    fetch_types: false,
    connection: { application_name: 'allrice-worker-wakeup' },
    socket: (parsed: { host: string[]; port: number[]; path?: string }) => {
      const socket = parsed.path
        ? connect(parsed.path)
        : connect(parsed.port[0]!, parsed.host[0]);
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      return socket;
    },
  };
  const subscriber = postgres(databaseUrl, subscriberOptions);
  const close = async () => {
    await subscriber.end({ timeout: 0 });
    for (const socket of sockets) socket.destroy();
  };
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
