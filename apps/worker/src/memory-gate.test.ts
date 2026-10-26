import { totalmem } from 'node:os';
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
  type MemoryAdmission,
} from './memory-gate.js';
import { detectWorkerCapacity, workerCapacity } from './worker-capacity.js';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const defaults = memoryGateSettings({});
/** M1 Dev, 16 GiB, 10-26: libuv said 80 MB free while the kernel reported
 * normal pressure, 59% free in `memory_pressure`, and these jetsam pages:
 * free, speculative, pageable file-backed, purgeable, page size. */
const m1 = '1\n3664\n1463\n185712\n1821\n16384\n';
const m1AvailableBytes = (3664 + 1463 + 185712 + 1821) * 16384;

function probe(overrides: Partial<HostMemoryProbe>): HostMemoryProbe {
  return {
    platform: 'darwin',
    availableMemory: () => 80 * MiB,
    memorystatus: async () => m1,
    memorystatusSync: () => m1,
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
  it('reads the kernel pressure level and reclaimable pages on macOS, not free pages', async () => {
    await expect(readHostMemory(probe({}))).resolves.toEqual({
      source: 'memorystatus',
      pressure: 'normal',
      availableBytes: m1AvailableBytes,
    });
    expect(
      readHostMemorySync(
        probe({ memorystatusSync: () => '4 100 0 2000 0 16384' }),
      ),
    ).toEqual({
      source: 'memorystatus',
      pressure: 'critical',
      availableBytes: 2100 * 16384,
    });
    expect(parseMemorystatus('2 1 1 1 1 4096').pressure).toBe('warn');
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
    for (const output of [
      '',
      '1 1 1 1 1',
      '3 1 1 1 1 16384',
      '1 1 1 1 1 16384 9',
      '1 -1 1 1 1 16384',
      '1 1.5 1 1 1 16384',
      '1 x 1 1 1 16384',
    ])
      expect(() => parseMemorystatus(output)).toThrow(
        'MEMORYSTATUS_UNREADABLE',
      );
    const broken = probe({
      memorystatus: () => Promise.reject(Error('spawn EAGAIN')),
      memorystatusSync: () => 'garbage',
    });
    await expect(readHostMemory(broken)).resolves.toMatchObject({
      source: 'available_memory',
      availableBytes: 80 * MiB,
      pressure: null,
      error: 'spawn EAGAIN',
    });
    expect(readHostMemorySync(broken)).toMatchObject({
      source: 'available_memory',
      error: expect.stringContaining('MEMORYSTATUS_UNREADABLE'),
    });
  });

  it.runIf(process.platform === 'darwin')(
    'reads this Mac without privilege',
    async () => {
      for (const reading of [await readHostMemory(), readHostMemorySync()]) {
        expect(reading).toMatchObject({ source: 'memorystatus' });
        expect(reading.error).toBeUndefined();
        expect(reading.availableBytes).toBeGreaterThan(0);
        expect(reading.availableBytes).toBeLessThanOrEqual(totalmem());
      }
    },
  );

  it('sizes automatic concurrency from the same estimate, whatever the free pages were', () => {
    // 16 GiB, 10 cores: about 2.9 GiB reclaimable gives 11 slots. Free pages
    // gave 2 to 13 across Dev restarts; memory_pressure's 59% would give 32.
    expect(
      workerCapacity({
        cpus: 10,
        memoryBytes: 16 * GiB,
        availableBytes: parseMemorystatus(m1).availableBytes,
      }).concurrency,
    ).toBe(11);
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
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('claim admission by memory pressure (MET-219)', () => {
  it('keeps the byte floor at its exact boundary, even when pressure checks are off', () => {
    const settings = memoryGateSettings({
      ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE: 'off',
    });
    expect(
      memoryAdmission(memory({ availableBytes: 256 * MiB }), settings).claim,
    ).toBe('all');
    expect(
      memoryAdmission(memory({ availableBytes: 256 * MiB - 1 }), settings),
    ).toMatchObject({ claim: 'none', reason: 'available_below_minimum' });
    expect(
      memoryAdmission(memory({ pressure: 'critical', availableBytes: 0 }), {
        ...defaults,
        minAvailableBytes: 0,
      }),
    ).toMatchObject({ claim: 'none', reason: 'pressure_critical' });
    for (const value of ['1048577', 'Infinity', 'NaN'])
      expect(() =>
        memoryGateSettings({ ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB: value }),
      ).toThrow();
  });

  it('defaults to a 256 MB floor and pausing only at critical pressure', () => {
    expect(defaults).toEqual({
      minAvailableBytes: 256 * MiB,
      pausePressure: 'critical',
    });
    expect(
      memoryGateSettings({
        ALLRICE_WORKER_MIN_AVAILABLE_MEMORY_MB: '',
        ALLRICE_WORKER_MEMORY_PAUSE_PRESSURE: ' ',
      }),
    ).toEqual(defaults);
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

  it('admits by pressure level, reduces at warn, and keeps the byte floor', () => {
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
    expect(decide({ pressure: 'warn' })).toEqual(['reduced', 'pressure_warn']);
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
    // macOS: reclaimable pages exhausted even though the level still says normal.
    expect(decide({ availableBytes: 200 * MiB })).toEqual([
      'none',
      'available_below_minimum',
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

  it('samples at most every two seconds and logs at most once a minute, folding flaps into the next line', async () => {
    let clock = 0;
    let current = memory({ pressure: 'critical', availableBytes: GiB });
    const read = vi.fn(async () => current);
    const log = vi.fn();
    const gate = createMemoryGate({
      settings: defaults,
      read,
      sampleMs: 2_000,
      now: () => clock,
      log,
    });
    await Promise.all([gate.admission(), gate.admission()]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([
      [
        '[MET-219] memory gate paused claims',
        {
          claim: 'none',
          reason: 'pressure_critical',
          source: 'memorystatus',
          pressure: 'critical',
          availableMiB: 1024,
          minAvailableMiB: 256,
          pausePressure: 'critical',
          stateMs: 0,
          changes: 1,
        },
      ],
    ]);
    for (clock = 1_000; clock < 60_000; clock += 1_000) await gate.admission();
    expect(read).toHaveBeenCalledTimes(30);
    expect(log).toHaveBeenCalledTimes(1);
    clock = 60_000;
    await gate.admission();
    expect(log).toHaveBeenLastCalledWith(
      '[MET-219] memory gate still pausing claims',
      expect.objectContaining({ stateMs: 60_000, changes: 0 }),
    );
    // Hovering at the threshold: three changes, no lines until a minute on.
    for (const [at, pressure] of [
      [62_000, 'normal'],
      [64_000, 'critical'],
      [66_000, 'normal'],
    ] as const) {
      clock = at;
      current = memory({ pressure });
      await gate.admission();
    }
    for (clock = 68_000; clock < 120_000; clock += 2_000)
      await gate.admission();
    expect(log).toHaveBeenCalledTimes(2);
    clock = 120_000;
    await gate.admission();
    expect(log).toHaveBeenLastCalledWith(
      '[MET-219] memory gate resumed claims',
      expect.objectContaining({
        claim: 'all',
        stateMs: 54_000,
        changes: 3,
        restrictedMs: 66_000,
      }),
    );
    for (clock = 122_000; clock < 300_000; clock += 2_000)
      await gate.admission();
    expect(log).toHaveBeenCalledTimes(3);
    current = memory({ pressure: 'warn' });
    await gate.admission();
    expect(log).toHaveBeenLastCalledWith(
      '[MET-219] memory gate reduced claims',
      expect.objectContaining({ claim: 'reduced', reason: 'pressure_warn' }),
    );
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

  it('claims until slots are full, halves them at warn, keeps a slot from background work and stops on none or shutdown', async () => {
    const queue = ['a', 'b', 'c', 'd', 'e'];
    const started: string[] = [];
    const offers: boolean[] = [];
    let claim: MemoryAdmission['claim'] = 'all';
    let stopping = false;
    let stopDuringAdmission = false;
    const tick = () =>
      claimUnderMemoryGate({
        gate: {
          admission: async () => {
            if (stopDuringAdmission) stopping = true;
            return { claim, reason: null, memory: memory({}) };
          },
        },
        concurrency: 4,
        active: () => started.length,
        stopping: () => stopping,
        claim: async ({ allowBackground }) => {
          offers.push(allowBackground);
          const id = queue.shift();
          return id ? { id, lease: { token: `t-${id}` } } : null;
        },
        start: (job) => started.push(job.id),
      });
    claim = 'none';
    await tick();
    stopDuringAdmission = true;
    claim = 'all';
    await tick();
    expect(offers).toEqual([]);
    stopDuringAdmission = stopping = false;
    claim = 'reduced';
    started.push('running');
    await tick();
    expect(started).toEqual(['running', 'a']);
    await tick();
    expect(started).toEqual(['running', 'a']);
    expect(offers).toEqual([false]);
    claim = 'all';
    await tick();
    expect(started).toEqual(['running', 'a', 'b', 'c']);
    expect(offers).toEqual([false, true, false]);
  });

  it('rereads libuv memory before every claim on Linux, so a job that used the room stops the next claim', async () => {
    const readings = [512 * MiB, 64 * MiB];
    const read = vi.fn(async () =>
      memory({
        source: 'available_memory',
        pressure: null,
        availableBytes: readings.shift() ?? 64 * MiB,
      }),
    );
    const gate = createMemoryGate({
      settings: defaults,
      read,
      sampleMs: 0,
      log: () => undefined,
    });
    const started: string[] = [];
    await claimUnderMemoryGate({
      gate,
      concurrency: 4,
      active: () => started.length,
      stopping: () => false,
      claim: async () => ({
        id: `job-${started.length}`,
        lease: { token: 't' },
      }),
      start: (job) => started.push(job.id),
    });
    expect(started).toEqual(['job-0']);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
