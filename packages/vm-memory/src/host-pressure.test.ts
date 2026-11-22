import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonVmBinding } from '@allrice/person-vm';
import {
  createVmMemoryHostPressureProducer,
  type VmMemoryHostPressureCommand,
} from './host-pressure.ts';

const binding: PersonVmBinding = {
  vmId: 'synthetic-vm',
  personId: 'synthetic-person',
  organizationId: 'synthetic-org',
  instanceId: 'synthetic-instance',
  leaseEpoch: 1,
};
const memory = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 123.
Pages active: 456.
Pages inactive: 789.
Pages speculative: 3.
Pages wired down: 12.
Pages occupied by compressor: 45.
`;
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const outputs = (percentage = 40, level = 1) => [
  `System-wide memory free percentage: ${percentage}%\n`,
  memory,
  `${level}\n`,
];
const index = (request: VmMemoryHostPressureCommand) =>
  request.executable === '/usr/bin/memory_pressure'
    ? 0
    : request.executable === '/usr/bin/vm_stat'
      ? 1
      : 2;
function fixture(values = outputs()) {
  const command = vi.fn(
    async (request: VmMemoryHostPressureCommand) => values[index(request)]!,
  );
  const input = {
    command,
    policyRef: 'synthetic-approved-40-percent-policy',
    cadence: { intervalMs: 1_000, policyRef: 'synthetic-explicit-cadence' },
  };
  return {
    command,
    input,
    producer: createVmMemoryHostPressureProducer(input),
  };
}

describe('host pressure producer (synthetic command results; no actual host pressure)', () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    [40, 1, 'parallel'],
    [100, 2, 'parallel'],
    [39.99, 1, 'serial'],
    [0, 2, 'serial'],
    [90, 4, 'stop'],
    [0, 4, 'stop'],
  ] as const)(
    'maps %s percent / level %s to %s without collapsing serial',
    async (percentage, level, capacity) => {
      const h = fixture(outputs(percentage, level));
      const sample = await h.producer.read(
        binding,
        new AbortController().signal,
      );
      expect(sample).toMatchObject({
        binding,
        state: 'available',
        capacity,
        pressureLevel: level,
        freePercent: percentage,
        vmStat: { pageBytes: 16_384, freePages: 123, compressorPages: 45 },
      });
      expect(
        h.command.mock.calls.map(([request]) => [
          request.executable,
          request.args,
        ]),
      ).toEqual([
        ['/usr/bin/memory_pressure', ['-Q']],
        ['/usr/bin/vm_stat', []],
        ['/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']],
      ]);
      expect(sample).not.toHaveProperty('physical');
    },
  );

  it.each([
    [0, ''],
    [0, 'System-wide memory free percentage: 101%'],
    [
      0,
      'System-wide memory free percentage: 40%\nSystem-wide memory free percentage: 50%',
    ],
    [1, ''],
    [1, memory.replace('123.', '9007199254740992.')],
    [1, `${memory}Pages free: 1.\n`],
    [2, ''],
    [2, '3'],
    [2, '1\n4'],
    [2, 'sysctl: unavailable'],
  ] as const)(
    'keeps malformed source %s unavailable (%s)',
    async (source, malformed) => {
      const values = outputs();
      values[source] = malformed;
      const sample = await fixture(values).producer.read(
        binding,
        new AbortController().signal,
      );
      expect(sample).toMatchObject({
        state: 'unavailable',
        capacity: null,
        pressureLevel: null,
        freePercent: null,
        vmStat: null,
      });
    },
  );

  it.each([undefined, 0, -1, 1.5, 2_147_483_648])(
    'requires explicit representable cadence (%s)',
    (intervalMs) => {
      const h = fixture();
      expect(() =>
        createVmMemoryHostPressureProducer({
          ...h.input,
          cadence: { ...h.input.cadence, intervalMs: intervalMs as number },
        }),
      ).toThrow('内存状态暂不可核实');
      expect(h.command).not.toHaveBeenCalled();
    },
  );

  it('does not return a source failure until all sibling utility children join', async () => {
    const joins = [gate(), gate()];
    const h = fixture();
    h.command.mockImplementation(async (request) => {
      if (index(request) === 2) throw new Error('synthetic sysctl failure');
      await joins[index(request)]!.promise;
      return outputs()[index(request)]!;
    });
    let settled = false;
    const result = h.producer
      .read(binding, new AbortController().signal)
      .then((sample) => {
        settled = true;
        return sample;
      });
    await Promise.resolve();
    expect(h.command).toHaveBeenCalledTimes(3);
    expect(
      h.command.mock.calls.every(([request]) => request.signal.aborted),
    ).toBe(true);
    joins[0]!.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    joins[1]!.resolve();
    expect(await result).toMatchObject({
      state: 'unavailable',
      capacity: null,
      pressureLevel: null,
    });
  });

  it('preserves cancellation only after all actual runner promises have joined', async () => {
    const joins = [gate(), gate(), gate()];
    const h = fixture();
    h.command.mockImplementation(async (request) => {
      await joins[index(request)]!.promise;
      return outputs()[index(request)]!;
    });
    const cancel = new AbortController();
    const reason = new Error('synthetic owner cancellation');
    const result = h.producer.read(binding, cancel.signal);
    const assertion = expect(result).rejects.toBe(reason);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    cancel.abort(reason);
    expect(
      h.command.mock.calls.every(([request]) => request.signal.aborted),
    ).toBe(true);
    joins[0]!.resolve();
    joins[1]!.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    joins[2]!.resolve();
    await assertion;
  });

  it('revises on resource/policy facts, without manufacturing freshness revisions', async () => {
    const values = outputs();
    const h = fixture(values);
    const signal = new AbortController().signal;
    const first = await h.producer.read(binding, signal);
    expect((await h.producer.read(binding, signal)).revision).toBe(
      first.revision,
    );
    values[0] = outputs(39)[0]!;
    expect((await h.producer.read(binding, signal)).revision).not.toBe(
      first.revision,
    );
    const changedPolicy = createVmMemoryHostPressureProducer({
      ...h.input,
      policyRef: 'synthetic-policy-2',
    });
    expect((await changedPolicy.read(binding, signal)).revision).not.toBe(
      first.revision,
    );
  });

  it('invalidates while sampling, retains notifications, and never overlaps probes', async () => {
    vi.useFakeTimers();
    const h = fixture();
    const watch = await h.producer.watch(binding, new AbortController().signal);
    const joins = [gate(), gate(), gate()];
    try {
      await watch.wait(); // Retained initial sample notification.
      h.command.mockImplementation(async (request) => {
        await joins[index(request)]!.promise;
        return outputs(39)[index(request)]!;
      });
      const sampling = watch.wait();
      await vi.advanceTimersByTimeAsync(1_000);
      await sampling;
      expect(watch.read()).toBeNull(); // A notification is not admission.
      expect(h.command).toHaveBeenCalledTimes(6);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.command).toHaveBeenCalledTimes(6);
      const sampled = watch.wait();
      joins.forEach((join) => join.resolve());
      await sampled;
      expect(watch.read()).toMatchObject({
        state: 'available',
        capacity: 'serial',
      });
    } finally {
      joins.forEach((join) => join.resolve());
      await watch.close();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it('close invalidates immediately, rejects terminal wait, and joins in-flight commands', async () => {
    vi.useFakeTimers();
    const h = fixture();
    const watch = await h.producer.watch(binding, new AbortController().signal);
    const joins = [gate(), gate(), gate()];
    try {
      await watch.wait();
      h.command.mockImplementation(async (request) => {
        await joins[index(request)]!.promise;
        return outputs()[index(request)]!;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const closing = watch.close();
      expect(watch.close()).toBe(closing);
      expect(watch.read()).toBeNull();
      await expect(watch.wait()).rejects.toMatchObject({
        code: 'MEMORY_OBSERVATION_UNAVAILABLE',
      });
      expect(
        h.command.mock.calls
          .slice(3)
          .every(([request]) => request.signal.aborted),
      ).toBe(true);
      let joined = false;
      void closing.then(() => {
        joined = true;
      });
      joins[0]!.resolve();
      joins[1]!.resolve();
      await Promise.resolve();
      expect(joined).toBe(false);
      joins[2]!.resolve();
      await closing;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.command).toHaveBeenCalledTimes(6);
    } finally {
      joins.forEach((join) => join.resolve());
      await watch.close();
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it('aborts watch setup only after its late command results are joined', async () => {
    const joins = [gate(), gate(), gate()];
    const h = fixture();
    h.command.mockImplementation(async (request) => {
      await joins[index(request)]!.promise;
      return outputs()[index(request)]!;
    });
    const cancel = new AbortController();
    const reason = new Error('synthetic setup cancellation');
    const setup = h.producer.watch(binding, cancel.signal);
    const assertion = expect(setup).rejects.toBe(reason);
    cancel.abort(reason);
    joins.forEach((join) => join.resolve());
    await assertion;
    expect(h.command).toHaveBeenCalledTimes(3);
    expect(
      h.command.mock.calls.every(([request]) => request.signal.aborted),
    ).toBe(true);
  });
});
