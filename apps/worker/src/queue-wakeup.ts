/** MET-223: tick the queue as soon as PostgreSQL announces a claimable job, so
 * a sent message or a due reminder is claimed in milliseconds instead of on the
 * next poll. This only adds earlier ticks: the interval poll stays the
 * correctness path, so a lost announcement or a dead listener costs latency,
 * never a job. */

export type QueueWakeReason = 'notify' | 'due' | 'listen';

export interface ReadyJobSubscription {
  pid(): number | null;
  close(): Promise<void>;
}

export interface QueueWakeupOptions {
  /** Must settle in bounded time and give up once `signal` aborts. */
  listen(
    onReady: (payload: string) => void,
    onListen: () => void,
    options: { signal: AbortSignal },
  ): Promise<ReadyJobSubscription>;
  probe(payload: string): Promise<void>;
  wake(reason: QueueWakeReason): void;
  probeIntervalMs?: number;
  /** Round trip allowed once the probe has been sent. */
  probeTimeoutMs?: number;
  /** Future jobs further out than this are left to the poll. */
  horizonMs?: number;
  log?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
}

export type QueueWakeupStatus = ReturnType<
  ReturnType<typeof startQueueWakeups>['status']
>;

const DUE_MERGE_MS = 10;
const DUE_SLACK_MS = 25;
const MAX_PENDING_DUE = 64;

export function startQueueWakeups(options: QueueWakeupOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? console;
  const probeIntervalMs = options.probeIntervalMs ?? 30_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 10_000;
  const horizonMs = options.horizonMs ?? 5 * 60_000;
  const probePrefix = `probe:${Math.random().toString(36).slice(2)}:`;
  const wakes = { notify: 0, due: 0, listen: 0 };
  let subscription: ReadyJobSubscription | null = null;
  let connecting: Promise<void> | null = null;
  let connectAborter: AbortController | null = null;
  let stopped = false;
  let listening = false;
  let probeSeq = 0;
  let pendingProbe: string | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnects = 0;
  let resubscribes = 0;
  let lastProbeOkAt: number | null = null;
  let lastError: string | undefined;
  let due: number[] = [];
  let dueTimer: ReturnType<typeof setTimeout> | null = null;
  let armedAt: number | null = null;

  function wake(reason: QueueWakeReason) {
    if (stopped) return;
    wakes[reason]++;
    options.wake(reason);
  }

  function armDue() {
    const next = due[0] ?? null;
    if (next === armedAt) return;
    if (dueTimer) clearTimeout(dueTimer);
    dueTimer = null;
    armedAt = next;
    if (next === null) return;
    dueTimer = setTimeout(fireDue, Math.max(0, next - now() + DUE_SLACK_MS));
  }

  function fireDue() {
    dueTimer = null;
    armedAt = null;
    const fired = now();
    // Only deadlines that have passed; a later one keeps its own timer.
    due = due.filter((at) => at > fired);
    wake('due');
    armDue();
  }

  function onReady(payload: string) {
    if (payload.startsWith('probe:')) {
      if (payload === pendingProbe) settleProbe(true);
      return;
    }
    const at = payload === '' ? Number.NaN : Number(payload);
    const delay = at - now();
    if (!Number.isFinite(at) || delay <= 0) return wake('notify');
    if (delay > horizonMs) return;
    // An earlier deadline within the merge window fires after this one too.
    if (due.some((existing) => existing <= at && at - existing <= DUE_MERGE_MS))
      return;
    // The earliest deadlines matter most; anything dropped is still polled.
    due = [...due, at].sort((a, b) => a - b).slice(0, MAX_PENDING_DUE);
    armDue();
  }

  function onListen() {
    if (!listening) log.info('[MET-223] queue wakeup listening');
    else {
      // postgres.js re-listened by itself after its connection dropped.
      resubscribes++;
      log.info('[MET-223] queue wakeup resubscribed', {
        pid: subscription?.pid() ?? null,
      });
    }
    listening = true;
    lastError = undefined;
    // Announcements sent while unsubscribed are gone; sweep once.
    wake('listen');
  }

  function connect() {
    if (stopped || subscription || connecting) return connecting;
    const aborter = new AbortController();
    connectAborter = aborter;
    connecting = options
      .listen(onReady, onListen, { signal: aborter.signal })
      .then(async (opened) => {
        if (stopped) return opened.close();
        subscription = opened;
      })
      .catch((error: unknown) => {
        listening = false;
        lastError = error instanceof Error ? error.message : String(error);
        log.warn('[MET-223] queue wakeup listen failed; polling only', {
          message: lastError,
        });
      })
      .finally(() => {
        connecting = null;
        if (connectAborter === aborter) connectAborter = null;
      });
    return connecting;
  }

  async function recycle(reason: string) {
    log.warn('[MET-223] queue wakeup stalled; reconnecting', { reason });
    reconnects++;
    listening = false;
    const stale = subscription;
    subscription = null;
    // Ending the dedicated connection also drops a silently dead socket.
    await stale?.close().catch(() => {});
    await connect();
  }

  function settleProbe(received: boolean) {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    pendingProbe = null;
    if (received) lastProbeOkAt = now();
    else if (!stopped) void recycle('probe_timeout');
  }

  function probeTick() {
    if (stopped || connecting || pendingProbe) return;
    if (!subscription) return void connect();
    const payload = `${probePrefix}${++probeSeq}`;
    pendingProbe = payload;
    // Time the LISTEN connection only: waiting for a busy shared pool to send
    // the probe says nothing about it.
    options.probe(payload).then(
      () => {
        if (pendingProbe === payload && !probeTimer && !stopped)
          probeTimer = setTimeout(() => settleProbe(false), probeTimeoutMs);
      },
      (error: unknown) => {
        // The shared pool is down too; the poll reports that. Do not recycle.
        if (pendingProbe !== payload) return;
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = null;
        pendingProbe = null;
        lastError = error instanceof Error ? error.message : String(error);
      },
    );
  }

  const probeInterval = setInterval(probeTick, probeIntervalMs);
  void connect();

  return {
    status() {
      return {
        state: stopped
          ? ('stopped' as const)
          : listening && subscription
            ? ('listening' as const)
            : ('polling_only' as const),
        pid: subscription?.pid() ?? null,
        wakes: { ...wakes },
        pendingDue: due.length,
        reconnects,
        resubscribes,
        lastProbeOkAt: lastProbeOkAt && new Date(lastProbeOkAt).toISOString(),
        ...(lastError ? { lastError } : {}),
      };
    },
    async stop() {
      stopped = true;
      clearInterval(probeInterval);
      if (probeTimer) clearTimeout(probeTimer);
      if (dueTimer) clearTimeout(dueTimer);
      connectAborter?.abort();
      await connecting;
      const current = subscription;
      subscription = null;
      listening = false;
      await current?.close();
    },
  };
}

/** One queue tick at a time. A request arriving mid-tick runs exactly one more
 * tick afterwards, because the running one may already have passed its claim. */
export function createCoalescedTick(
  run: () => Promise<void>,
  canRun: () => boolean,
) {
  let task: Promise<void> | null = null;
  let again = false;
  function tick(): Promise<void> | null {
    if (task || !canRun()) return task;
    task = run().finally(() => {
      task = null;
      if (again) {
        again = false;
        void tick();
      }
    });
    return task;
  }
  return {
    tick,
    request() {
      if (task) again = true;
      else void tick();
    },
    current: () => task,
  };
}
