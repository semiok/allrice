import { expect, it } from 'vitest';
import {
  createWorkerStartupObservation,
  type StartupObservation,
} from './startup-observation.js';

function fixture(emit?: (event: StartupObservation) => void) {
  const events: StartupObservation[] = [];
  let clock = 20;
  let cpu = { user: 10, system: 2 };
  const observer = createWorkerStartupObservation({
    bootId: '19500000-0000-4000-8000-000000000001',
    pid: 195,
    now: () => clock,
    wallNow: () => '2026-10-20T00:00:00.000Z',
    cpu: () => ({ ...cpu }),
    emit: (event) => {
      events.push(event);
      emit?.(event);
    },
  });
  return {
    events,
    observer,
    advance(ms: number) {
      clock += ms;
      cpu = { user: cpu.user + 7, system: cpu.system + 3 };
    },
  };
}

it('correlates entrypoint, measured phases and process-window CPU with one boot/PID and monotonic sequence', async () => {
  const f = fixture();
  const result = { unchanged: true };
  await expect(
    f.observer.run('service_identity', (observe) => {
      observe({ kind: 'read', bytes: 3 });
      observe({ kind: 'read', bytes: 0 });
      observe({ kind: 'package' });
      observe({ kind: 'cache', hit: false });
      observe({ kind: 'cache', hit: true });
      f.advance(11);
      return result;
    }),
  ).resolves.toBe(result);
  expect(new Set(f.events.map((e) => e.bootId))).toEqual(
    new Set([f.observer.bootId]),
  );
  expect(f.events.map((e) => e.pid)).toEqual([195, 195, 195]);
  expect(f.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  expect(f.events[2]).toMatchObject({
    state: 'completed',
    durationMs: 11,
    elapsedMs: 11,
    processWindowCpuMicros: { user: 7, system: 3 },
    counters: {
      releaseReadOperations: 2,
      releaseReadBytes: 3,
      packageInstances: 1,
      cacheHits: 1,
      cacheMisses: 1,
    },
  });
});

it('leaves unmeasured I/O and cache data unknown instead of reporting fabricated zeroes', async () => {
  const f = fixture();
  await f.observer.run('native_journal_contract', async () => undefined);
  expect(f.events.at(-1)?.counters).toEqual({
    releaseReadOperations: null,
    releaseReadBytes: null,
    packageInstances: null,
    cacheHits: null,
    cacheMisses: null,
  });
});

it('preserves the original failure and never serializes error messages, paths or attached credentials', async () => {
  const f = fixture();
  const error = Object.assign(Error('/private/credentials?secret=do-not-log'), {
    prompt: 'user prompt',
    token: 'secret-token',
  });
  await expect(
    f.observer.run('native_primary', async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(f.events.at(-1)).toMatchObject({
    phase: 'native_primary',
    state: 'failed',
    failure: 'operation_failed',
  });
  expect(JSON.stringify(f.events)).not.toMatch(
    /credentials|do-not-log|user prompt|secret-token/,
  );
  expect(f.events.some((e) => e.state === 'completed')).toBe(false);
});

it.each([
  ['AbortError', 'operation_aborted'],
  ['TimeoutError', 'operation_timeout'],
] as const)(
  'records %s without catching cancellation or changing its result',
  async (name, failure) => {
    const f = fixture();
    const error = Error('sensitive original message');
    error.name = name;
    await expect(
      f.observer.run('native_primary', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(f.events.at(-1)?.failure).toBe(failure);
  },
);

it('a broken sink cannot replace a successful value or the original rejected operation', async () => {
  const f = fixture(() => {
    throw Error('log sink failed');
  });
  const value = { verified: false };
  await expect(
    f.observer.run('native_launch_policy', () => value),
  ).resolves.toBe(value);
  const error = Error('original verification failure');
  await expect(
    f.observer.run('native_primary', () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

it('does not let an error name accessor replace the original rejection', async () => {
  const f = fixture();
  const error = Error('original');
  Object.defineProperty(error, 'name', {
    get() {
      throw Error('name getter');
    },
  });
  let observed: unknown;
  try {
    await f.observer.run('native_primary', () => {
      throw error;
    });
  } catch (caught) {
    observed = caught;
  }
  expect(observed === error).toBe(true);
  expect(f.events.at(-1)?.failure).toBe('operation_failed');
});

it('keeps the last started phase for a stalled operation without inventing a deadline or completion', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = f.observer.run(
    'native_primary',
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  expect(f.events.at(-1)).toMatchObject({
    phase: 'native_primary',
    state: 'started',
  });
  expect(f.events.some((e) => e.state === 'completed')).toBe(false);
  release();
  await pending;
  expect(f.events.at(-1)?.state).toBe('completed');
});

it('retained slot spans finish once, ignore late metrics and never expose an invalid slot', () => {
  const f = fixture();
  const slot = f.observer.start('native_journal_contract', { slot: 6 });
  slot.observe({ kind: 'read', bytes: 4 });
  slot.complete();
  slot.observe({ kind: 'read', bytes: 8 });
  slot.fail(Error('late failure'));
  expect(f.events.at(-1)).toMatchObject({
    slot: 6,
    state: 'completed',
    counters: { releaseReadBytes: 4 },
  });
  expect(f.events.filter((e) => e.state === 'completed')).toHaveLength(1);
  for (const invalidSlot of [0, 7, 6.5]) {
    f.observer.start('native_journal_contract', { slot: invalidSlot }).fail();
    expect(f.events.at(-1)).not.toHaveProperty('slot');
  }
});

it('keeps verification, consumer admission, listening and ready as independent one-time observations', () => {
  const f = fixture();
  f.observer.mark('verification_checks_completed');
  f.observer.mark('ordinary_consumer_entered');
  f.observer.mark('http_listening');
  f.observer.mark('http_listening');
  expect(f.events.some((e) => e.phase === 'health_ready')).toBe(false);
  f.observer.mark('health_ready');
  f.observer.mark('health_ready');
  expect(
    f.events.filter((e) => e.state === 'milestone').map((e) => e.phase),
  ).toEqual([
    'verification_checks_completed',
    'ordinary_consumer_entered',
    'http_listening',
    'health_ready',
  ]);
});

it('reports a maintenance-skipped producer separately from a successful probe or recovery', () => {
  const f = fixture();
  f.observer.start('provider_probes').skip();
  expect(f.events.at(-1)).toMatchObject({
    state: 'skipped',
    skipped: 'producer_not_admitted',
  });
  expect(f.events.at(-1)).not.toHaveProperty('failure');
  expect(f.events.some((e) => e.state === 'completed')).toBe(false);
});
