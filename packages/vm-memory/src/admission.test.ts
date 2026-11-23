import { describe, expect, it, vi } from 'vitest';
import type { PersonVmBinding } from '@allrice/person-vm';
import { createVmMemoryAdmission } from './admission.ts';
import { VM_PHYSICAL_MEMORY_BYTES, VmMemoryError } from './contract.ts';
import type { VmMemoryObservation } from './contract.ts';
import {
  FixtureMemorySource,
  memoryFixtureGate,
  memoryObservation,
} from './memory.fixture.ts';

const binding: PersonVmBinding = {
  vmId: 'synthetic-vm',
  personId: 'synthetic-person',
  organizationId: 'synthetic-org',
  instanceId: 'synthetic-instance',
  leaseEpoch: 1,
};
describe.sequential('external VM memory admission', () => {
  it('压力排队只认host事实；guest自报空闲不能放行，host正常也不由guest诊断改判', async () => {
    const source = new FixtureMemorySource(binding, 'pressure', 'stop');
    const controller = new AbortController();
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      controller.signal,
    );
    try {
      expect(watch.read()).toBe('queued');
      const wait = watch.wait();
      source.publish(memoryObservation(binding, 'normal', 'parallel'));
      await wait;
      expect(watch.read()).toBe('ready');
      source.publish({
        ...memoryObservation(binding, 'normal', 'parallel'),
        guest: {
          ramBytes: 1,
          availableBytes: 0,
          swapTotalBytes: 1,
          swapFreeBytes: 0,
          commandRamBytes: 1,
          commandSwapBytes: 1,
          dshRamBytes: 1,
          dshSwapBytes: 1,
          commandOomKills: 99,
          parentLocalOoms: 99,
          globalOomKills: 99,
        },
      });
      expect(watch.read()).toBe('ready');
    } finally {
      await watch.close();
    }
    expect(source.subscribers.size).toBe(0);
  });

  it.each([
    { pressure: 'normal', capacity: 'parallel', expected: 'ready' },
    { pressure: 'normal', capacity: 'serial', expected: 'serial' },
    { pressure: 'pressure', capacity: 'serial', expected: 'serial' },
    { pressure: 'pressure', capacity: 'stop', expected: 'queued' },
  ] as const)(
    'explicit host $pressure/$capacity yields $expected, keeping serialization distinct',
    async ({ pressure, capacity, expected }) => {
      const source = new FixtureMemorySource(binding, pressure, capacity);
      const watch = await createVmMemoryAdmission(source).watch(
        binding,
        new AbortController().signal,
      );
      try {
        expect(watch.read()).toBe(expected);
      } finally {
        await watch.close();
      }
      expect(source.closeCalls).toBe(1);
      expect(source.subscribers.size).toBe(0);
    },
  );

  it.each([undefined, null, '', 'normal', 'PARALLEL', 1])(
    'missing or malformed capacity %s never defaults to parallel',
    async (capacity) => {
      const source = new FixtureMemorySource(binding, 'normal', 'parallel');
      source.publish({
        ...memoryObservation(binding, 'normal', 'parallel'),
        capacity,
      } as unknown as VmMemoryObservation);
      const watch = await createVmMemoryAdmission(source).watch(
        binding,
        new AbortController().signal,
      );
      try {
        expect(() => watch.read()).toThrow(
          expect.objectContaining({ code: 'MEMORY_OBSERVATION_UNAVAILABLE' }),
        );
      } finally {
        await watch.close();
      }
    },
  );

  it.each([
    'vmId',
    'personId',
    'organizationId',
    'instanceId',
    'leaseEpoch',
  ] as const)('拒绝其他%s的观察，不能从guest或旧epoch获得放行', async (key) => {
    const source = new FixtureMemorySource(binding, 'normal', 'parallel');
    source.publish({
      ...memoryObservation(binding, 'normal', 'parallel'),
      binding: {
        ...binding,
        [key]: key === 'leaseEpoch' ? 2 : 'other',
      },
    });
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      expect(() => watch.read()).toThrow('内存观察与当前会话实例不一致');
    } finally {
      await watch.close();
    }
  });

  it('物理cap需provider实读；配置值或guest MemTotal不能代替enforced readback', async () => {
    const source = new FixtureMemorySource(binding, 'normal', 'parallel');
    const observation = memoryObservation(binding, 'normal', 'parallel');
    source.publish({
      ...observation,
      physical: { ...observation.physical, enforcedBytes: 4 * 1024 ** 3 },
    });
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      expect(() => watch.read()).toThrow('虚拟机内存配置未通过核实');
    } finally {
      await watch.close();
    }
  });

  it.each([
    { name: 'missing', enforcedBytes: undefined },
    { name: 'unknown', enforcedBytes: null },
    { name: 'zero', enforcedBytes: 0 },
    { name: 'RSS-sized', enforcedBytes: 1234 },
    { name: 'oversized', enforcedBytes: VM_PHYSICAL_MEMORY_BYTES * 2 },
  ])('hardcap $name不能由正确configured、RSS或guest值补齐', async (cap) => {
    const source = new FixtureMemorySource(binding, 'normal', 'parallel');
    source.publish({
      ...memoryObservation(binding, 'normal', 'parallel'),
      physical: {
        configuredBytes: VM_PHYSICAL_MEMORY_BYTES,
        enforcedBytes: cap.enforcedBytes,
      },
      host: {
        vmRssBytes: VM_PHYSICAL_MEMORY_BYTES,
        helperRssBytes: 0,
        swapBytes: 0,
      },
      guest: {
        ramBytes: VM_PHYSICAL_MEMORY_BYTES,
        availableBytes: VM_PHYSICAL_MEMORY_BYTES,
        swapTotalBytes: VM_PHYSICAL_MEMORY_BYTES,
        swapFreeBytes: VM_PHYSICAL_MEMORY_BYTES,
        commandRamBytes: 0,
        commandSwapBytes: 0,
        dshRamBytes: 0,
        dshSwapBytes: 0,
        commandOomKills: 0,
        parentLocalOoms: 0,
        globalOomKills: 0,
      },
    } as unknown as VmMemoryObservation);
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      expect(() => watch.read()).toThrow(
        expect.objectContaining({ code: 'VM_MEMORY_CAP_INVALID' }),
      );
    } finally {
      await watch.close();
    }
    expect(source.subscribers.size).toBe(0);
  });

  it('source建立失败不返回可放行watch；已取消请求不开始建立source', async () => {
    const source = new FixtureMemorySource(binding, 'normal', 'parallel');
    const controller = new AbortController();
    const reason = new Error('synthetic-before-setup');
    controller.abort(reason);
    await expect(
      createVmMemoryAdmission(source).watch(binding, controller.signal),
    ).rejects.toBe(reason);
    expect(source.bindings).toEqual([]);
    const cause = new Error('synthetic-observer-unavailable');
    await expect(
      createVmMemoryAdmission({
        async watch() {
          throw cause;
        },
      }).watch(binding, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'MEMORY_OBSERVATION_UNAVAILABLE',
      cause,
    });
  });

  it('建立中取消后晚到watch先等真实detach，不能返回ready或留下订阅', async () => {
    const source = new FixtureMemorySource(binding, 'normal', 'parallel');
    const setup = memoryFixtureGate();
    const detach = memoryFixtureGate();
    source.setupGate = setup.promise;
    source.detachGate = detach.promise;
    const controller = new AbortController();
    const reason = new Error('synthetic-cancel-during-setup');
    let settled = false;
    const result = createVmMemoryAdmission(source)
      .watch(binding, controller.signal)
      .then(
        (watch) => {
          settled = true;
          return watch;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
    try {
      await source.setupStarted.promise;
      expect(source.subscribers.size).toBe(1);
      controller.abort(reason);
      setup.resolve();
      await source.closeStarted.promise;
      expect(settled).toBe(false);
      expect(source.closeCalls).toBe(1);
      expect(source.subscribers.size).toBe(1);
      detach.resolve();
      expect(await result).toBe(reason);
      expect(source.subscribers.size).toBe(0);
    } finally {
      setup.resolve();
      detach.resolve();
      await result;
    }
  });

  it('并发close共用真实detach，关闭后read和已挂起wait都不再放行', async () => {
    const source = new FixtureMemorySource(binding, 'pressure', 'stop');
    const detach = memoryFixtureGate();
    source.detachGate = detach.promise;
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    const waiting = watch.wait().catch((error: unknown) => error);
    try {
      await source.waiting.promise;
      const first = watch.close();
      const second = watch.close();
      let detached = false;
      void first.then(() => {
        detached = true;
      });
      expect(first).toBe(second);
      await source.closeStarted.promise;
      expect(detached).toBe(false);
      expect(source.closeCalls).toBe(1);
      expect(source.subscribers.size).toBe(1);
      expect(() => watch.read()).toThrow(VmMemoryError);
      detach.resolve();
      await first;
      expect(await waiting).toMatchObject({
        code: 'MEMORY_OBSERVATION_UNAVAILABLE',
      });
      await watch.close();
      expect(source.subscribers.size).toBe(0);
      expect(source.closeCalls).toBe(1);
    } finally {
      detach.resolve();
      await watch.close();
      await waiting;
    }
  });

  it('断连与旧epoch通知不丢；只在当前host观察恢复normal后放行', async () => {
    const source = new FixtureMemorySource(binding, 'normal', 'parallel');
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      expect(watch.read()).toBe('ready');
      source.publish(null);
      await watch.wait();
      expect(() => watch.read()).toThrow(
        expect.objectContaining({ code: 'MEMORY_OBSERVATION_UNAVAILABLE' }),
      );
      const reconnected = watch.wait();
      source.publish({
        ...memoryObservation(binding, 'normal', 'parallel'),
        binding: { ...binding, leaseEpoch: binding.leaseEpoch - 1 },
      });
      await reconnected;
      expect(() => watch.read()).toThrow(
        expect.objectContaining({ code: 'MEMORY_BINDING_INVALID' }),
      );
      source.publish(memoryObservation(binding, 'pressure', 'stop'));
      await watch.wait();
      expect(watch.read()).toBe('queued');
      const recovered = watch.wait();
      source.publish(memoryObservation(binding, 'normal', 'parallel'));
      await recovered;
      expect(watch.read()).toBe('ready');
    } finally {
      await watch.close();
    }
    expect(source.subscribers.size).toBe(0);
  });

  it('重复pressure只唤醒通知不放行，无通知不空转，取消仅释放观察不发kill', async () => {
    const source = new FixtureMemorySource(binding, 'pressure', 'stop');
    const controller = new AbortController();
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      controller.signal,
    );
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    let pending: Promise<unknown> | undefined;
    try {
      for (let pulse = 0; pulse < 3; pulse++) {
        let notified = false;
        pending = watch.wait().then(
          () => {
            notified = true;
          },
          (error: unknown) => error,
        );
        await Promise.resolve();
        expect(notified).toBe(false);
        expect(source.waitCalls).toBe(pulse + 1);
        expect(watch.read()).toBe('queued');
        source.publish(memoryObservation(binding, 'pressure', 'stop'));
        await pending;
        expect(notified).toBe(true);
        expect(watch.read()).toBe('queued');
      }
      pending = watch.wait().catch((error: unknown) => error);
      expect(source.waitCalls).toBe(4);
      const reason = new Error('synthetic-pressure-wait-cancel');
      controller.abort(reason);
      expect(await pending).toBe(reason);
      await watch.close();
      expect(source.closeCalls).toBe(1);
      expect(source.subscribers.size).toBe(0);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      try {
        controller.abort();
        await watch.close();
        await pending;
      } finally {
        kill.mockRestore();
      }
    }
  });

  it('host计量未知用显式null；漏字段不能冒称完整观察', async () => {
    const source = new FixtureMemorySource(binding, 'normal', 'parallel');
    source.publish({
      ...memoryObservation(binding, 'normal', 'parallel'),
      host: {
        vmRssBytes: null,
        helperRssBytes: null,
        swapBytes: null,
      },
    });
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      expect(watch.read()).toBe('ready');
      source.publish({
        ...memoryObservation(binding, 'normal', 'parallel'),
        host: {},
      } as unknown as ReturnType<typeof memoryObservation>);
      expect(() => watch.read()).toThrow(VmMemoryError);
    } finally {
      await watch.close();
    }
  });

  it.each([null, 'unavailable'] as const)(
    '观察缺失/失效%s不默认放行',
    async (value) => {
      const source = new FixtureMemorySource(binding, 'normal', 'parallel');
      source.publish(
        value === null ? null : memoryObservation(binding, value, 'parallel'),
      );
      const watch = await createVmMemoryAdmission(source).watch(
        binding,
        new AbortController().signal,
      );
      try {
        expect(() => watch.read()).toThrow(VmMemoryError);
      } finally {
        await watch.close();
      }
    },
  );

  it('先订阅再读，wait前的通知不丢；取消关闭等真实detach且close幂等', async () => {
    const source = new FixtureMemorySource(binding, 'pressure', 'stop');
    const controller = new AbortController();
    const watch = await createVmMemoryAdmission(source).watch(
      binding,
      controller.signal,
    );
    source.publish(memoryObservation(binding, 'normal', 'parallel'));
    await watch.wait();
    expect(watch.read()).toBe('ready');
    const pending = watch.wait().catch((error: unknown) => error);
    controller.abort(new Error('synthetic-cancel'));
    expect(await pending).toMatchObject({ message: 'synthetic-cancel' });
    await watch.close();
    await watch.close();
    expect(source.subscribers.size).toBe(0);
  });
});
