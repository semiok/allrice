import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCoalescedTick,
  startQueueWakeups,
  type QueueWakeReason,
  type QueueWakeupOptions,
} from './queue-wakeup.js';

const quiet = { info: () => {}, warn: () => {} };

/** In-memory stand-in for the LISTEN connection: `notify` reaches the active
 * subscription only, the way PostgreSQL delivers to live listeners. */
function fakeChannel() {
  const opened: {
    onReady: (payload: string) => void;
    onListen: () => void;
    closed: boolean;
  }[] = [];
  let failNext: Error | null = null;
  let deliverProbes = true;
  const listen = vi.fn<QueueWakeupOptions['listen']>(
    async (onReady, onListen) => {
      if (failNext) {
        const error = failNext;
        failNext = null;
        throw error;
      }
      const entry = { onReady, onListen, closed: false };
      opened.push(entry);
      onListen();
      return {
        pid: () => 4242,
        close: vi.fn(async () => {
          entry.closed = true;
        }),
      };
    },
  );
  const active = () => opened.filter((entry) => !entry.closed);
  return {
    listen,
    opened,
    notify: (payload: string) =>
      active().forEach((entry) => entry.onReady(payload)),
    probe: vi.fn(async (payload: string) => {
      if (deliverProbes) active().forEach((entry) => entry.onReady(payload));
    }),
    /** postgres.js re-running LISTEN after its socket dropped. */
    relisten: () => active().forEach((entry) => entry.onListen()),
    failNextListen(error: Error) {
      failNext = error;
    },
    dropProbes() {
      deliverProbes = false;
    },
  };
}

describe('queue wakeups (MET-223)', () => {
  let wakes: QueueWakeReason[];
  let stops: (() => Promise<void>)[];
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse('2026-10-26T08:00:00Z') });
    wakes = [];
    stops = [];
  });
  afterEach(async () => {
    await Promise.all(stops.map((stop) => stop()));
    vi.useRealTimers();
  });
  async function start(
    channel: ReturnType<typeof fakeChannel>,
    overrides: Partial<QueueWakeupOptions> = {},
  ) {
    const wakeups = startQueueWakeups({
      listen: channel.listen,
      probe: channel.probe,
      wake: (reason) => wakes.push(reason),
      probeIntervalMs: 30_000,
      probeTimeoutMs: 5_000,
      log: quiet,
      ...overrides,
    });
    stops.push(() => wakeups.stop());
    await vi.advanceTimersByTimeAsync(0);
    return wakeups;
  }

  it('sweeps once when subscribed and ticks at once for a job claimable now', async () => {
    const channel = fakeChannel();
    const wakeups = await start(channel);
    expect(wakes).toEqual(['listen']);
    channel.notify('');
    channel.notify(String(Date.now() - 50));
    channel.notify('not-a-number');
    expect(wakes).toEqual(['listen', 'notify', 'notify', 'notify']);
    expect(wakeups.status()).toMatchObject({
      state: 'listening',
      pid: 4242,
      wakes: { listen: 1, notify: 3, due: 0 },
    });
  });

  it('ticks when a future job becomes due, merging close deadlines and leaving far ones to the poll', async () => {
    const channel = fakeChannel();
    const wakeups = await start(channel, { horizonMs: 60_000 });
    wakes.length = 0;
    const dueAt = Date.now() + 2_000;
    channel.notify(String(dueAt));
    channel.notify(String(dueAt + 5));
    channel.notify(String(Date.now() + 5_000));
    channel.notify(String(Date.now() + 120_000));
    expect(wakeups.status().pendingDue).toBe(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(wakes).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(wakes).toEqual(['due']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(wakes).toEqual(['due', 'due']);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(wakes).toEqual(['due', 'due']);
    expect(wakeups.status().pendingDue).toBe(0);
  });

  it('keeps a later deadline armed when an earlier one fires, and waits out sub-slack delays', async () => {
    const channel = fakeChannel();
    const wakeups = await start(channel);
    wakes.length = 0;
    const first = Date.now() + 1_000;
    channel.notify(String(first));
    channel.notify(String(first + 40));
    await vi.advanceTimersByTimeAsync(1_000 + 25);
    expect(wakes).toEqual(['due']);
    expect(wakeups.status().pendingDue).toBe(1);
    await vi.advanceTimersByTimeAsync(39);
    expect(wakes).toEqual(['due']);
    await vi.advanceTimersByTimeAsync(1);
    expect(wakes).toEqual(['due', 'due']);
    // 10 ms ahead is still ahead: tick once it is claimable, not before.
    channel.notify(String(Date.now() + 10));
    expect(wakes).toEqual(['due', 'due']);
    await vi.advanceTimersByTimeAsync(10 + 25);
    expect(wakes).toEqual(['due', 'due', 'due']);
    expect(wakeups.status().pendingDue).toBe(0);
  });

  it('keeps a subscription whose probe comes back, and ignores probes of other Workers', async () => {
    const channel = fakeChannel();
    const wakeups = await start(channel);
    channel.notify('probe:someone-else:1');
    await vi.advanceTimersByTimeAsync(30_000 + 5_000);
    expect(channel.probe).toHaveBeenCalledTimes(1);
    expect(channel.listen).toHaveBeenCalledTimes(1);
    expect(wakes).toEqual(['listen']);
    expect(wakeups.status()).toMatchObject({
      state: 'listening',
      reconnects: 0,
    });
  });

  it('cancels due timers and a pending probe when stopped', async () => {
    const channel = fakeChannel();
    const wakeups = await start(channel, {
      probeIntervalMs: 100,
      probeTimeoutMs: 200,
    });
    channel.notify(String(Date.now() + 1_000));
    channel.dropProbes();
    await vi.advanceTimersByTimeAsync(100);
    await wakeups.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wakes).toEqual(['listen']);
    expect(channel.listen).toHaveBeenCalledTimes(1);
    expect(channel.opened.every((s) => s.closed)).toBe(true);
  });

  it('reopens the connection and sweeps again when a probe is lost', async () => {
    const channel = fakeChannel();
    const wakeups = await start(channel);
    channel.dropProbes();
    await vi.advanceTimersByTimeAsync(30_000 + 5_000);
    expect(channel.opened.map((entry) => entry.closed)).toEqual([true, false]);
    expect(wakes).toEqual(['listen', 'listen']);
    expect(wakeups.status()).toMatchObject({
      state: 'listening',
      reconnects: 1,
    });
  });

  it('counts a resubscription by the driver and sweeps for what it missed', async () => {
    const channel = fakeChannel();
    const wakeups = await start(channel);
    channel.relisten();
    expect(wakes).toEqual(['listen', 'listen']);
    expect(wakeups.status()).toMatchObject({
      state: 'listening',
      resubscribes: 1,
      reconnects: 0,
    });
  });

  it('times the probe from when it was sent, not while the shared pool is busy', async () => {
    const channel = fakeChannel();
    channel.probe.mockImplementationOnce(async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      channel.notify(payload);
    });
    const wakeups = await start(channel);
    await vi.advanceTimersByTimeAsync(30_000 + 8_000);
    expect(channel.listen).toHaveBeenCalledTimes(1);
    expect(wakeups.status()).toMatchObject({
      reconnects: 0,
      lastProbeOkAt: new Date(Date.now()).toISOString(),
    });
  });

  it('falls back to polling when LISTEN fails and retries on the next probe interval', async () => {
    const channel = fakeChannel();
    channel.failNextListen(new Error('connect ECONNREFUSED'));
    const wakeups = await start(channel);
    expect(wakes).toEqual([]);
    expect(wakeups.status()).toMatchObject({
      state: 'polling_only',
      lastError: 'connect ECONNREFUSED',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(wakes).toEqual(['listen']);
    expect(wakeups.status()).toMatchObject({ state: 'listening' });
    expect(wakeups.status()).not.toHaveProperty('lastError');
  });

  it('does not recycle the subscription when the shared pool cannot send the probe', async () => {
    const channel = fakeChannel();
    channel.probe.mockRejectedValueOnce(new Error('pool down'));
    const wakeups = await start(channel);
    await vi.advanceTimersByTimeAsync(30_000 + 5_000);
    expect(channel.listen).toHaveBeenCalledTimes(1);
    expect(wakeups.status()).toMatchObject({
      reconnects: 0,
      lastError: 'pool down',
    });
  });

  it('aborts a LISTEN that never answers when stopping, instead of waiting on it', async () => {
    const hanging: QueueWakeupOptions['listen'] = (
      _ready,
      _listen,
      { signal },
    ) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const wakeups = startQueueWakeups({
      listen: hanging,
      probe: async () => {},
      wake: (reason) => wakes.push(reason),
      log: quiet,
    });
    await vi.advanceTimersByTimeAsync(240_000);
    await expect(wakeups.stop()).resolves.toBeUndefined();
    expect(wakes).toEqual([]);
  });

  it('stops waking after stop() and closes a subscription that opens late', async () => {
    const channel = fakeChannel();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listen: QueueWakeupOptions['listen'] = async (
      onReady,
      onListen,
      options,
    ) => {
      await gate;
      return channel.listen(onReady, onListen, options);
    };
    const wakeups = startQueueWakeups({
      listen,
      probe: channel.probe,
      wake: (reason) => wakes.push(reason),
      log: quiet,
    });
    const stopped = wakeups.stop();
    release();
    await stopped;
    channel.notify('');
    expect(channel.opened.map((entry) => entry.closed)).toEqual([true]);
    expect(wakes).toEqual([]);
    expect(wakeups.status().state).toBe('stopped');
  });
});

describe('coalesced queue tick (MET-223)', () => {
  it('coalesces 10,000 in-flight requests and suppresses the follow-up after shutdown', async () => {
    let release!: () => void;
    let ready = true;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const ticks = createCoalescedTick(run, () => ready);
    const first = ticks.tick();
    for (let i = 0; i < 10_000; i++) ticks.request();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
    const second = ticks.current();
    ticks.request();
    ready = false;
    release();
    await second;
    expect(run).toHaveBeenCalledTimes(2);
    expect(ticks.current()).toBeNull();
  });

  it('runs one more tick for requests that arrive mid-tick, and none when idle', async () => {
    const releases: (() => void)[] = [];
    const run = vi.fn(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const ticks = createCoalescedTick(run, () => true);
    const first = ticks.tick();
    expect(ticks.tick()).toBe(first);
    ticks.request();
    ticks.request();
    expect(run).toHaveBeenCalledTimes(1);
    releases[0]!();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
    releases[1]!();
    await ticks.current();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(2);
    expect(ticks.current()).toBeNull();
    ticks.request();
    expect(run).toHaveBeenCalledTimes(3);
    releases[2]!();
  });

  it('starts nothing while the Worker is stopping or not ready', () => {
    const run = vi.fn(async () => {});
    let ready = false;
    const ticks = createCoalescedTick(run, () => ready);
    expect(ticks.tick()).toBeNull();
    ticks.request();
    expect(run).not.toHaveBeenCalled();
    ready = true;
    ticks.request();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
