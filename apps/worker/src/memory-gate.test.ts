import { describe, expect, it, vi } from 'vitest';
import {
  parseMemorystatus,
  readHostMemory,
  readHostMemorySync,
  type HostMemory,
  type HostMemoryProbe,
} from './host-memory.js';
import {
  claimUnderMemoryGate,
  createMemoryGate,
  memoryAdmission,
  memoryGateSettings,
} from './memory-gate.js';
import { detectWorkerCapacity } from './worker-capacity.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const defaults = memoryGateSettings({});

function probe(overrides: Partial<HostMemoryProbe>): HostMemoryProbe {
  return {
    platform: 'darwin',
    totalBytes: 16 * GiB,
    availableMemory: () => 120 * MiB,
    memorystatus: async () => '1\n76\n',
    memorystatusSync: () => '1\n76\n',
    ...overrides,
  };
}
const memory = (overrides: Partial<HostMemory>): HostMemory => ({
  source: 'memorystatus',
  availableBytes: 8 * GiB,
  pressure: 'normal',
  ...overrides,
});

describe('host memory (MET-219)', () => {
  it('reads the kernel pressure level and free percentage on macOS, not free pages', async () => {
    // The M1 Dev reading that stalled claims: 120 MB free pages, pressure normal.
    await expect(readHostMemory(probe({}))).resolves.toEqual({
      source: 'memorystatus',
      pressure: 'normal',
      availableBytes: Math.floor(16 * GiB * 0.76),
    });
    expect(
      readHostMemorySync(probe({ memorystatusSync: () => '4 3' })),
    ).toEqual({
      source: 'memorystatus',
      pressure: 'critical',
      availableBytes: Math.floor(16 * GiB * 0.03),
    });
    expect(parseMemorystatus('2\n40\n', 100).pressure).toBe('warn');
  });

  it('keeps libuv semantics on Linux and falls back to them when sysctl fails', async () => {
    const linux = probe({
      platform: 'linux',
      availableMemory: () => 3 * GiB,
      memorystatus: () => Promise.reject(Error('must not run')),
    });
    await expect(readHostMemory(linux)).resolves.toEqual({
      source: 'available_memory',
      availableBytes: 3 * GiB,
      pressure: null,
    });
    for (const output of ['', '1', '3\n50', '1\n101', '1\n7.5', '1\n50\n9'])
      expect(() => parseMemorystatus(output, GiB)).toThrow(
        'MEMORYSTATUS_UNREADABLE',
      );
    const broken = probe({
      memorystatus: () => Promise.reject(Error('spawn EAGAIN')),
      memorystatusSync: () => 'garbage',
    });
    await expect(readHostMemory(broken)).resolves.toMatchObject({
      source: 'available_memory',
      availableBytes: 120 * MiB,
      pressure: null,
      error: 'spawn EAGAIN',
    });
    expect(readHostMemorySync(broken)).toMatchObject({
      source: 'available_memory',
      error: expect.stringContaining('MEMORYSTATUS_UNREADABLE'),
    });
  });

  it('sizes automatic concurrency from the same estimate, whatever the free pages were', () => {
    vi.stubEnv('ALLRICE_WORKER_CONCURRENCY', 'auto');
    try {
      const from = (availableBytes: number) =>
        detectWorkerCapacity(memory({ availableBytes }));
      expect(from(0)).toMatchObject({
        mode: 'auto',
        concurrency: 1,
        availableBytes: 0,
        memorySource: 'memorystatus',
      });
      const roomy = from(Number.MAX_SAFE_INTEGER);
      expect(roomy.availableBytes).toBe(roomy.memoryBytes);
      expect(roomy.concurrency).toBeGreaterThan(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('claim admission by memory pressure (MET-219)', () => {
  it('defaults to a 256 MB floor and pausing only at critical pressure', () => {
    expect(defaults).toEqual({
      minAvailableBytes: 256 * MiB,
      pausePressure: 'critical',
    });
    expect(
      memoryGateSettings({
        ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB: '0',
        ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE: 'warn',
      }),
    ).toEqual({ minAvailableBytes: 0, pausePressure: 'warn' });
    for (const env of [
      { ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB: '-1' },
      { ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB: '1.5' },
      { ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB: 'lots' },
      { ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE: 'normal' },
      { ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE: 'CRITICAL' },
    ])
      expect(() => memoryGateSettings(env)).toThrow();
  });

  it('admits by pressure level, holds background work at warn, and keeps the byte floor', () => {
    const decide = (
      m: Partial<HostMemory>,
      settings: Partial<typeof defaults> = {},
    ) => {
      const { claim, reason } = memoryAdmission(memory(m), {
        ...defaults,
        ...settings,
      });
      return [claim, reason];
    };
    expect(decide({ pressure: 'normal' })).toEqual(['all', null]);
    expect(decide({ pressure: 'warn' })).toEqual([
      'foreground',
      'pressure_warn',
    ]);
    expect(decide({ pressure: 'critical' })).toEqual([
      'none',
      'pressure_critical',
    ]);
    expect(decide({ pressure: 'warn' }, { pausePressure: 'warn' })).toEqual([
      'none',
      'pressure_warn',
    ]);
    expect(decide({ pressure: 'critical' }, { pausePressure: 'off' })).toEqual([
      'all',
      null,
    ]);
    // Linux keeps the old rule, now configurable.
    const linux = { source: 'available_memory' as const, pressure: null };
    expect(decide({ ...linux, availableBytes: 200 * MiB })).toEqual([
      'none',
      'available_below_minimum',
    ]);
    expect(
      decide(
        { ...linux, availableBytes: 200 * MiB },
        { minAvailableBytes: 128 * MiB },
      ),
    ).toEqual(['all', null]);
    expect(
      decide({ ...linux, availableBytes: 0 }, { minAvailableBytes: 0 }),
    ).toEqual(['all', null]);
  });

  it('samples at most every two seconds and logs a pause when it starts, each minute and when it ends', async () => {
    let clock = 0;
    let current = memory({ pressure: 'critical', availableBytes: GiB });
    const read = vi.fn(async () => current);
    const log = vi.fn();
    const gate = createMemoryGate({
      settings: defaults,
      read,
      now: () => clock,
      log,
    });
    await Promise.all([gate.admission(), gate.admission()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(
      '[MET-219] memory gate paused claims',
      {
        claim: 'none',
        reason: 'pressure_critical',
        source: 'memorystatus',
        pressure: 'critical',
        availableMiB: 1024,
        minAvailableMiB: 256,
        pausePressure: 'critical',
      },
    );
    for (clock = 1_000; clock < 60_000; clock += 1_000) await gate.admission();
    expect(read).toHaveBeenCalledTimes(30);
    expect(log).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await gate.admission();
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.lastCall?.[0]).toBe(
      '[MET-219] memory gate still pausing claims',
    );
    current = memory({ pressure: 'normal' });
    clock = 62_000;
    expect((await gate.admission()).claim).toBe('all');
    expect(log).toHaveBeenLastCalledWith(
      '[MET-219] memory gate resumed claims',
      expect.objectContaining({ claim: 'all', pausedMs: 62_000 }),
    );
    clock = 64_000;
    await gate.admission();
    expect(log).toHaveBeenCalledTimes(3);
  });

  it('reports an unreadable memorystatus at most every ten minutes', async () => {
    let clock = 0;
    const log = vi.fn();
    const gate = createMemoryGate({
      settings: defaults,
      read: async () =>
        memory({
          source: 'available_memory',
          pressure: null,
          error: 'spawn EAGAIN',
        }),
      now: () => clock,
      log,
    });
    for (; clock <= 600_000; clock += 2_000) await gate.admission();
    expect(log.mock.calls).toEqual([
      [
        '[MET-219] memory pressure unreadable, using availableMemory()',
        { error: 'spawn EAGAIN' },
      ],
      [
        '[MET-219] memory pressure unreadable, using availableMemory()',
        { error: 'spawn EAGAIN' },
      ],
    ]);
  });

  it('claims until slots are full, offers background work only with a spare slot, and stops on none', async () => {
    const queue = ['a', 'b', 'c', 'd'];
    const started: string[] = [];
    const offers: boolean[] = [];
    let admission: 'all' | 'foreground' | 'none' = 'all';
    const tick = () =>
      claimUnderMemoryGate({
        gate: {
          admission: async () => ({
            claim: admission,
            reason: null,
            memory: memory({}),
          }),
        },
        concurrency: 3,
        active: () => started.length,
        stopping: () => false,
        claim: async ({ allowBackground }) => {
          offers.push(allowBackground);
          const id = queue.shift();
          return id ? { id, lease: { token: `t-${id}` } } : null;
        },
        start: (job) => started.push(job.id),
      });
    admission = 'none';
    await tick();
    expect(offers).toEqual([]);
    admission = 'foreground';
    started.push('running');
    await tick();
    expect(started).toEqual(['running', 'a', 'b']);
    expect(offers).toEqual([false, false]);
    started.splice(0, 2);
    admission = 'all';
    await tick();
    expect(started).toEqual(['b', 'c', 'd']);
    expect(offers).toEqual([false, false, true, false]);
  });
});
