import { setImmediate } from 'node:timers';
import { describe, expect, it, vi } from 'vitest';
import type { PersonVmBinding } from './contract.ts';
import type {
  PersonVmNativeResourceFacts,
  PersonVmNativeResourcePort,
  PersonVmResourceLiveness,
  PersonVmResourcePort,
} from './resource-contract.ts';
import { createPersonVmResourcePort } from './resource-watch.ts';

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

/** Synthetic buffered source; never represents a native resource producer. */
class Pulse<T> {
  private pending = false;
  private waiters = new Set<() => void>();
  closed = false;
  closeGate = Promise.resolve();
  value: T | null;
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
    if (this.closed) return;
    if (this.pending) this.pending = false;
    else await new Promise<void>((resolve) => this.waiters.add(resolve));
  });
  close = vi.fn(async () => {
    this.closed = true;
    this.publish(null);
    await this.closeGate;
  });
}

const liveness = (revision = 'life-1'): PersonVmResourceLiveness => ({
  binding,
  revision,
  evidenceRef: 'synthetic-authority/native-liveness',
});
const facts = (revision = 'resource-1'): PersonVmNativeResourceFacts => ({
  binding,
  revision,
  evidenceRef: 'synthetic-resource-evidence',
  physical: {
    state: 'verified',
    configuredBytes: 2 * 1024 ** 3,
    enforcedBytes: 2 * 1024 ** 3,
    sourceRef: 'synthetic-runtime-cap',
  },
  host: { vmRssBytes: 42, helperRssBytes: null, swapBytes: 0 },
});
const fixture = () => {
  const lifecycle = new Pulse(liveness());
  const resources = new Pulse('resource-1');
  const read = vi.fn(async () => facts(resources.value!));
  const lifecycleWatch = vi.fn(async () => lifecycle);
  const subscribe = vi.fn(async () => resources);
  const native: PersonVmNativeResourcePort = { read, subscribe };
  const port = createPersonVmResourcePort({
    lifecycle: { watch: lifecycleWatch },
    native,
  });
  return {
    lifecycle,
    resources,
    read,
    lifecycleWatch,
    subscribe,
    native,
    port,
  };
};

describe('resource consumer (synthetic sources; no native/VM acceptance)', () => {
  it('requires an independent native change subscription, not just liveness/read', () => {
    expect(() =>
      createPersonVmResourcePort({
        lifecycle: { watch: vi.fn() },
        native: { read: vi.fn() } as unknown as PersonVmNativeResourcePort,
      }),
    ).toThrow('RUNTIME_NOT_READY');
  });

  it('subscribes before read, keeps resource/lifecycle revisions separate, and never polls', async () => {
    const h = fixture();
    h.read.mockImplementation(async () => {
      expect(h.lifecycleWatch).toHaveBeenCalledOnce();
      expect(h.subscribe).toHaveBeenCalledOnce();
      expect(h.lifecycle.wait).toHaveBeenCalledOnce();
      expect(h.resources.wait).toHaveBeenCalledOnce();
      return facts();
    });
    const watch = await h.port.watch(
      context,
      binding,
      new AbortController().signal,
    );
    try {
      expect(watch.read()?.revision).toBe('resource-1');
      expect(h.lifecycleWatch.mock.calls[0]).toEqual([
        context,
        binding,
        expect.any(AbortSignal),
      ]);
      await watch.wait(); // Drain the initial observation notification.
      let woke = false;
      const waiting = watch.wait().then(() => {
        woke = true;
      });
      await turn();
      expect(woke).toBe(false);
      expect(h.read).toHaveBeenCalledOnce();
      const rejected = expect(waiting).rejects.toMatchObject({
        code: 'RUNTIME_NOT_READY',
      });
      await watch.close();
      await rejected;
      await expect(watch.wait()).rejects.toMatchObject({
        code: 'RUNTIME_NOT_READY',
      });
    } finally {
      await watch.close();
    }
    expect(h.lifecycle.close).toHaveBeenCalledOnce();
    expect(h.resources.close).toHaveBeenCalledOnce();
  });

  it('invalidates synchronously on a resource pulse and rejects a late old revision', async () => {
    const h = fixture();
    const oldRead = gate(),
      entered = gate();
    const watch = await h.port.watch(
      context,
      binding,
      new AbortController().signal,
    );
    let readSignal: AbortSignal | undefined;
    h.native.read = vi.fn(async (_binding, signal) => {
      readSignal = signal;
      entered.resolve();
      await oldRead.promise; // Deliberately ignores cancellation until released.
      return facts('resource-2');
    });
    try {
      h.resources.publish('resource-2');
      expect(watch.read()).toBe(null);
      await entered.promise;
      h.resources.publish('resource-3');
      await turn();
      expect(readSignal?.aborted).toBe(true);
      expect(h.native.read).toHaveBeenCalledOnce(); // Join before the next read.
      h.native.read = vi.fn(async () => facts('resource-3'));
      oldRead.resolve();
      await turn();
      expect(watch.read()?.revision).toBe('resource-3');
      expect(h.native.read).toHaveBeenCalledOnce();
    } finally {
      oldRead.resolve();
      await watch.close();
    }
  });

  it('injected liveness invalidation is immediately null; late I/O cannot restore facts', async () => {
    const h = fixture();
    const late = gate(),
      entered = gate();
    const watch = await h.port.watch(
      context,
      binding,
      new AbortController().signal,
    );
    h.native.read = vi.fn(async () => {
      entered.resolve();
      await late.promise;
      return facts('resource-2');
    });
    try {
      await watch.wait();
      h.resources.publish('resource-2');
      await entered.promise;
      h.lifecycle.publish(null);
      expect(watch.read()).toBe(null);
      await watch.wait();
      late.resolve();
      await turn();
      expect(watch.read()).toBe(null);
      // Recovery needs a new owner liveness event, not completion of old I/O.
      h.native.read = vi.fn(async () => facts('resource-2'));
      h.lifecycle.publish(liveness('life-2'));
      await turn();
      expect(watch.read()?.revision).toBe('resource-2');
    } finally {
      late.resolve();
      await watch.close();
    }
  });

  it('native disconnect invalidates independently; reconnect requires a fresh resource revision/read', async () => {
    const h = fixture();
    const watch = await h.port.watch(
      context,
      binding,
      new AbortController().signal,
    );
    try {
      h.resources.publish(null);
      expect(watch.read()).toBe(null);
      await turn();
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.lifecycle.value?.revision).toBe('life-1');
      h.resources.publish('resource-reconnected');
      await turn();
      expect(watch.read()?.revision).toBe('resource-reconnected');
      expect(h.read).toHaveBeenCalledTimes(2);
    } finally {
      await watch.close();
    }
  });

  it.each([
    'vmId',
    'personId',
    'organizationId',
    'instanceId',
    'leaseEpoch',
  ] as const)('rejects a different %s from either source', async (field) => {
    const h = fixture();
    const other = { ...binding, [field]: field === 'leaseEpoch' ? 2 : 'other' };
    h.read.mockResolvedValue({ ...facts(), binding: other });
    const watch = await h.port.watch(
      context,
      binding,
      new AbortController().signal,
    );
    try {
      expect(watch.read()).toBe(null);
      h.read.mockResolvedValue(facts());
      h.lifecycle.publish({ ...liveness('life-2'), binding: other });
      await turn();
      expect(watch.read()).toBe(null);
      expect(h.read).toHaveBeenCalledOnce();
    } finally {
      await watch.close();
    }
  });

  it.each([
    { ...facts(), revision: 'stale-resource' },
    { ...facts(), evidenceRef: '' },
    { ...facts(), host: { ...facts().host, helperRssBytes: -1 } },
    {
      ...facts(),
      physical: {
        state: 'verified',
        configuredBytes: 1,
        enforcedBytes: undefined,
        sourceRef: 'x',
      },
    },
  ])('refuses malformed or stale native facts %#', async (observation) => {
    const h = fixture();
    h.read.mockResolvedValue(observation as PersonVmNativeResourceFacts);
    const watch = await h.port.watch(
      context,
      binding,
      new AbortController().signal,
    );
    try {
      expect(watch.read()).toBe(null);
    } finally {
      await watch.close();
    }
  });

  it('keeps an explicit unknown cap diagnostic without inventing enforced bytes', async () => {
    const h = fixture();
    h.read.mockResolvedValue({
      ...facts(),
      physical: {
        state: 'unknown',
        configuredBytes: 2 * 1024 ** 3,
        reason: 'unsupported public fixed-memory readback',
      },
    });
    const watch = await h.port.watch(
      context,
      binding,
      new AbortController().signal,
    );
    try {
      expect(watch.read()?.physical).toEqual({
        state: 'unknown',
        configuredBytes: 2 * 1024 ** 3,
        reason: 'unsupported public fixed-memory readback',
      });
      expect(watch.read()?.physical).not.toHaveProperty('enforcedBytes');
    } finally {
      await watch.close();
    }
  });

  it('setup cancellation joins a late subscription and its real close before rejecting', async () => {
    const h = fixture();
    const entered = gate(),
      late = gate(),
      detached = gate();
    const controller = new AbortController();
    const reason = new Error('cancel setup');
    h.resources.closeGate = detached.promise;
    h.native.subscribe = vi.fn(async () => {
      entered.resolve();
      await late.promise;
      return h.resources;
    });
    const opening = h.port.watch(context, binding, controller.signal);
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
    await turn();
    expect(h.lifecycle.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    late.resolve();
    await turn();
    expect(h.resources.close).toHaveBeenCalledOnce();
    expect(h.read).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    detached.resolve();
    await rejected;
  });

  it('close publishes one barrier, clears facts, and joins an uncooperative read plus detach', async () => {
    const h = fixture();
    const entered = gate(),
      readDone = gate(),
      detached = gate();
    const watch = await h.port.watch(
      context,
      binding,
      new AbortController().signal,
    );
    let readSignal: AbortSignal | undefined;
    h.native.read = vi.fn(async (_binding, signal) => {
      readSignal = signal;
      entered.resolve();
      await readDone.promise;
      return facts('resource-2');
    });
    h.resources.closeGate = detached.promise;
    h.resources.publish('resource-2');
    await entered.promise;
    const closing = watch.close();
    expect(watch.close()).toBe(closing);
    expect(watch.read()).toBe(null);
    expect(readSignal?.aborted).toBe(true);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await turn();
    detached.resolve();
    await turn();
    expect(settled).toBe(false);
    readDone.resolve();
    await closing;
    expect(h.lifecycle.close).toHaveBeenCalledOnce();
    expect(h.resources.close).toHaveBeenCalledOnce();
    expect(watch.read()).toBe(null);
  });
});
