import { setImmediate } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import type {
  PersonVmBinding,
  PersonVmNativeResourceFacts,
  PersonVmResourcePort,
} from '@allrice/person-vm';
import { createVmMemoryAdmission } from './admission.ts';
import { VM_PHYSICAL_MEMORY_BYTES } from './contract.ts';
import {
  createVmMemoryHostSource,
  type VmMemoryHostPressureObservation,
  type VmMemoryHostPressurePort,
} from './host-source.ts';

const binding: PersonVmBinding = {
  vmId: 'synthetic-vm',
  personId: 'synthetic-person',
  organizationId: 'synthetic-org',
  instanceId: 'synthetic-instance',
  leaseEpoch: 1,
};
const context: Parameters<PersonVmResourcePort['watch']>[0] = {
  requestId: 'synthetic-request',
  sessionId: 'synthetic-session',
  actor: { type: 'user', id: binding.personId },
  organizationId: binding.organizationId,
  workspaceId: null,
  memberships: [],
  authenticatedAt: '2026-11-22T00:00:00Z',
};
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Explicit test-only trusted input replacement; no native/pressure producer. */
class Pulse<T> {
  private pending = false;
  private waiters = new Set<() => void>();
  value: T | null;
  closed = false;
  activeWaits = 0;
  maxWaits = 0;
  closeGate = Promise.resolve();
  constructor(value: T | null) {
    this.value = value;
  }
  read = () => (this.closed ? null : this.value);
  publish(value: T | null) {
    this.value = value;
    this.pending = this.waiters.size === 0;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
  wait = vi.fn(async () => {
    this.activeWaits++;
    this.maxWaits = Math.max(this.maxWaits, this.activeWaits);
    try {
      if (this.closed) return;
      if (this.pending) this.pending = false;
      else await new Promise<void>((resolve) => this.waiters.add(resolve));
    } finally {
      this.activeWaits--;
    }
  });
  close = vi.fn(async () => {
    this.closed = true;
    this.publish(null);
    await this.closeGate;
  });
}

const resourceFacts = (): PersonVmNativeResourceFacts => ({
  binding,
  revision: 'synthetic-resource-1',
  evidenceRef: 'synthetic-native-evidence',
  physical: {
    state: 'verified',
    configuredBytes: VM_PHYSICAL_MEMORY_BYTES,
    enforcedBytes: VM_PHYSICAL_MEMORY_BYTES,
    sourceRef: 'synthetic-runtime-cap',
  },
  host: { vmRssBytes: 42, helperRssBytes: null, swapBytes: 0 },
});
const pressureFacts = (
  pressure: VmMemoryHostPressureObservation['pressure'] = 'normal',
): VmMemoryHostPressureObservation => ({
  binding,
  revision: 'synthetic-pressure-1',
  evidenceRef: 'synthetic-host-evidence',
  policyRef: 'synthetic-approved-policy',
  pressure,
});
const fixture = () => {
  const resources = new Pulse(resourceFacts());
  const pressure = new Pulse(pressureFacts());
  const resourceWatch = vi.fn(async () => resources);
  const pressureWatch = vi.fn(async () => pressure);
  const resourcePort: PersonVmResourcePort = { watch: resourceWatch };
  const pressurePort: VmMemoryHostPressurePort = { watch: pressureWatch };
  const source = createVmMemoryHostSource({
    context,
    resources: resourcePort,
    pressure: pressurePort,
  });
  return {
    resources,
    pressure,
    resourceWatch,
    pressureWatch,
    resourcePort,
    pressurePort,
    source,
  };
};

describe('host memory source consumer (synthetic inputs; not VM acceptance)', () => {
  it.each(['resources', 'pressure'] as const)(
    'requires the %s source; no default-open producer',
    (missing) => {
      const h = fixture();
      expect(() =>
        createVmMemoryHostSource({
          context,
          resources: h.resourcePort,
          pressure: h.pressurePort,
          [missing]: undefined,
        } as unknown as Parameters<typeof createVmMemoryHostSource>[0]),
      ).toThrow('内存状态暂不可核实');
    },
  );

  it('passes the trusted context/exact binding, subscribes before reads and preserves unknown helper attribution', async () => {
    const h = fixture();
    const original = h.resources.read;
    vi.spyOn(h.resources, 'read').mockImplementation(() => {
      expect(h.resourceWatch).toHaveBeenCalledOnce();
      expect(h.pressureWatch).toHaveBeenCalledOnce();
      expect(h.resources.wait).toHaveBeenCalledOnce();
      expect(h.pressure.wait).toHaveBeenCalledOnce();
      return original();
    });
    const watch = await h.source.watch(binding, new AbortController().signal);
    try {
      expect(h.resourceWatch.mock.calls[0]).toEqual([
        context,
        binding,
        expect.any(AbortSignal),
      ]);
      expect(h.pressureWatch.mock.calls[0]).toEqual([
        binding,
        expect.any(AbortSignal),
      ]);
      expect(watch.read()).toMatchObject({
        binding,
        pressure: 'normal',
        physical: {
          configuredBytes: VM_PHYSICAL_MEMORY_BYTES,
          enforcedBytes: VM_PHYSICAL_MEMORY_BYTES,
        },
        host: { vmRssBytes: 42, helperRssBytes: null, swapBytes: 0 },
        guest: null,
      });
      expect(watch.read()?.evidenceRef).toContain('synthetic-runtime-cap');
    } finally {
      await watch.close();
    }
  });

  it.each(['unknown', 'missing', 'null'] as const)(
    '%s hardcap never uses configuration or RSS to produce admission facts',
    async (state) => {
      const h = fixture();
      const facts = resourceFacts();
      const physical =
        state === 'unknown'
          ? {
              state: 'unknown',
              configuredBytes: VM_PHYSICAL_MEMORY_BYTES,
              reason: 'fixed-memory public readback unsupported',
            }
          : {
              state: 'verified',
              configuredBytes: VM_PHYSICAL_MEMORY_BYTES,
              enforcedBytes: state === 'null' ? null : undefined,
              sourceRef: 'synthetic',
            };
      h.resources.publish({
        ...facts,
        physical,
        host: { ...facts.host, vmRssBytes: VM_PHYSICAL_MEMORY_BYTES },
      } as PersonVmNativeResourceFacts);
      const watch = await createVmMemoryAdmission(h.source).watch(
        binding,
        new AbortController().signal,
      );
      try {
        expect(() => watch.read()).toThrow('内存状态暂不可核实');
      } finally {
        await watch.close();
      }
    },
  );

  it('preserves a verified different cap so the real admission entry rejects it', async () => {
    const h = fixture();
    h.resources.publish({
      ...resourceFacts(),
      physical: {
        state: 'verified',
        configuredBytes: VM_PHYSICAL_MEMORY_BYTES,
        enforcedBytes: 4 * 1024 ** 3,
        sourceRef: 'synthetic-actual-cap',
      },
    });
    const watch = await createVmMemoryAdmission(h.source).watch(
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
    null,
    pressureFacts('unavailable'),
    { ...pressureFacts(), evidenceRef: '' },
    { ...pressureFacts(), policyRef: '' },
    { ...pressureFacts(), revision: '' },
  ])(
    'missing/unavailable/unattributed pressure %# cannot become normal',
    async (facts) => {
      const h = fixture();
      h.pressure.publish(facts);
      const watch = await h.source.watch(binding, new AbortController().signal);
      try {
        expect(watch.read()).toBe(null);
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
  ] as const)('requires the same %s on both sources', async (field) => {
    const h = fixture();
    const other = { ...binding, [field]: field === 'leaseEpoch' ? 2 : 'other' };
    h.pressure.publish({ ...pressureFacts(), binding: other });
    const watch = await h.source.watch(binding, new AbortController().signal);
    try {
      expect(watch.read()).toBe(null);
      h.pressure.publish(pressureFacts());
      h.resources.publish({ ...resourceFacts(), binding: other });
      expect(watch.read()).toBe(null);
    } finally {
      await watch.close();
    }
  });

  it('retains a prior pressure pulse; notification stays queued and waits do not accumulate or spin', async () => {
    const h = fixture();
    h.pressure.publish(pressureFacts('pressure'));
    const watch = await createVmMemoryAdmission(h.source).watch(
      binding,
      new AbortController().signal,
    );
    try {
      await watch.wait();
      expect(watch.read()).toBe('queued');
      for (let index = 0; index < 3; index++) {
        h.pressure.publish({
          ...pressureFacts('pressure'),
          revision: `pressure-${index}`,
        });
        await watch.wait();
        expect(watch.read()).toBe('queued');
      }
      const before = [
        h.resources.wait.mock.calls.length,
        h.pressure.wait.mock.calls.length,
      ];
      let woke = false;
      const waiting = watch.wait().then(() => {
        woke = true;
      });
      await turn();
      expect(woke).toBe(false);
      expect([
        h.resources.wait.mock.calls.length,
        h.pressure.wait.mock.calls.length,
      ]).toEqual(before);
      expect(h.resources.maxWaits).toBe(1);
      expect(h.pressure.maxWaits).toBe(1);
      const rejected = expect(waiting).rejects.toMatchObject({
        code: 'MEMORY_OBSERVATION_UNAVAILABLE',
      });
      await watch.close();
      await rejected;
    } finally {
      await watch.close();
    }
  });

  it('resource invalidation is immediate despite normal pressure; reconnect and wrong epoch stay distinct', async () => {
    const h = fixture();
    const watch = await h.source.watch(binding, new AbortController().signal);
    try {
      h.resources.publish(null);
      expect(watch.read()).toBe(null);
      await turn();
      await watch.wait(); // The earlier invalidation is buffered.
      h.resources.publish({
        ...resourceFacts(),
        binding: { ...binding, leaseEpoch: 2 },
      });
      expect(watch.read()).toBe(null);
      h.resources.publish({
        ...resourceFacts(),
        revision: 'reconnected-resource',
      });
      expect(watch.read()?.pressure).toBe('normal');
      h.pressure.publish(null);
      expect(watch.read()).toBe(null);
      h.pressure.publish({
        ...pressureFacts('pressure'),
        revision: 'reconnected-pressure',
      });
      expect(watch.read()?.pressure).toBe('pressure');
    } finally {
      await watch.close();
    }
  });

  it('refuses a source which changes its revision between the paired synchronous reads', async () => {
    const h = fixture();
    let reads = 0;
    vi.spyOn(h.pressure, 'read').mockImplementation(() => ({
      ...pressureFacts(),
      revision: `revision-${reads++}`,
    }));
    const watch = await h.source.watch(binding, new AbortController().signal);
    try {
      expect(watch.read()).toBe(null);
    } finally {
      await watch.close();
    }
  });

  it('a failed input wait invalidates and cancels both sources without a synthetic recovery', async () => {
    const h = fixture();
    const watch = await h.source.watch(binding, new AbortController().signal);
    try {
      h.pressure.wait.mockRejectedValueOnce(new Error('synthetic disconnect'));
      h.pressure.publish(pressureFacts()); // Release the already pending wait.
      await turn();
      expect(watch.read()).toBe(null);
      await watch.close();
      expect(h.resources.close).toHaveBeenCalledOnce();
      expect(h.pressure.close).toHaveBeenCalledOnce();
      expect(h.resources.activeWaits).toBe(0);
      expect(h.pressure.activeWaits).toBe(0);
    } finally {
      await watch.close();
    }
  });

  it.each(['resources', 'pressure'] as const)(
    'cancels and joins late %s setup before preserving the abort reason',
    async (source) => {
      const h = fixture();
      const entered = gate(),
        late = gate(),
        detached = gate();
      const controller = new AbortController();
      const reason = new Error('cancel host source setup');
      const delayed = h[source];
      delayed.closeGate = detached.promise;
      if (source === 'resources')
        h.resourcePort.watch = vi.fn(async () => {
          entered.resolve();
          await late.promise;
          return h.resources;
        });
      else
        h.pressurePort.watch = vi.fn(async () => {
          entered.resolve();
          await late.promise;
          return h.pressure;
        });
      const opening = h.source.watch(binding, controller.signal);
      const rejected = expect(opening).rejects.toBe(reason);
      let settled = false;
      void opening.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await entered.promise;
      controller.abort(reason);
      late.resolve();
      await turn();
      expect(delayed.close).toHaveBeenCalledOnce();
      if (source === 'pressure')
        expect(h.resources.close).toHaveBeenCalledOnce();
      else expect(h.pressureWatch).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      detached.resolve();
      await rejected;
    },
  );

  it('close publishes one reentrant barrier and joins both disposers before reporting a cleanup failure', async () => {
    const h = fixture();
    const detached = gate();
    const failure = new Error('synthetic resource close failed');
    const watch = await h.source.watch(binding, new AbortController().signal);
    let nested: Promise<void> | undefined;
    h.resources.close.mockImplementation(async () => {
      h.resources.closed = true;
      h.resources.publish(null);
      nested = watch.close();
      throw failure;
    });
    h.pressure.closeGate = detached.promise;
    const closing = watch.close();
    const rejected = expect(closing).rejects.toBe(failure);
    expect(watch.close()).toBe(closing);
    expect(watch.read()).toBe(null);
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await turn();
    expect(nested).toBe(closing);
    expect(settled).toBe(false);
    expect(h.pressure.close).toHaveBeenCalledOnce();
    detached.resolve();
    await rejected;
    expect(h.resources.activeWaits).toBe(0);
    expect(h.pressure.activeWaits).toBe(0);
  });
});
