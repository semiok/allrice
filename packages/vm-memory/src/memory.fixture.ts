/** Synthetic, event-driven host source. Never production telemetry. */
import type { PersonVmBinding } from '@allrice/person-vm';
import { VM_PHYSICAL_MEMORY_BYTES } from './contract.ts';
import type {
  VmMemoryCapacity,
  VmMemoryObservation,
  VmMemorySource,
} from './contract.ts';

export function memoryFixtureGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export function memoryObservation(
  binding: PersonVmBinding,
  pressure: VmMemoryObservation['pressure'],
  capacity: VmMemoryCapacity,
): VmMemoryObservation {
  return {
    binding,
    revision: 'synthetic-1',
    evidenceRef: 'fixture:external-observer',
    pressure,
    capacity,
    physical: {
      configuredBytes: VM_PHYSICAL_MEMORY_BYTES,
      enforcedBytes: VM_PHYSICAL_MEMORY_BYTES,
    },
    host: { vmRssBytes: 1234, helperRssBytes: 567, swapBytes: 0 },
    guest: null,
  };
}
export class FixtureMemorySource implements VmMemorySource {
  observation: VmMemoryObservation | null;
  subscribers = new Set<() => void>();
  bindings: PersonVmBinding[] = [];
  waiting = memoryFixtureGate();
  detached = memoryFixtureGate();
  setupStarted = memoryFixtureGate();
  closeStarted = memoryFixtureGate();
  // Optional adversarial timing: a watch may finish setup after cancellation.
  // These gates are test controls, not a production observer implementation.
  setupGate?: Promise<void>;
  detachGate?: Promise<void>;
  closeCalls = 0;
  waitCalls = 0;
  constructor(
    binding: PersonVmBinding,
    pressure: VmMemoryObservation['pressure'],
    capacity: VmMemoryCapacity,
  ) {
    this.observation = memoryObservation(binding, pressure, capacity);
  }
  publish(value: VmMemoryObservation | null) {
    this.observation = value;
    for (const notify of this.subscribers) notify();
  }
  async watch(binding: PersonVmBinding, signal: AbortSignal) {
    signal.throwIfAborted();
    this.bindings.push(binding);
    let pending = false;
    let wake: (() => void) | undefined;
    let closed = false;
    const notify = () => {
      pending = true;
      wake?.();
      wake = undefined;
    };
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        closed = true;
        this.closeCalls++;
        this.closeStarted.resolve();
        if (this.detachGate) await this.detachGate;
        this.subscribers.delete(notify);
        signal.removeEventListener('abort', notify);
        notify();
        this.detached.resolve();
      })());
    this.subscribers.add(notify);
    signal.addEventListener('abort', notify);
    this.setupStarted.resolve();
    if (this.setupGate) await this.setupGate;
    return {
      read: () => this.observation,
      wait: async () => {
        this.waitCalls++;
        this.waiting.resolve();
        signal.throwIfAborted();
        if (closed) throw Error('synthetic_watch_closed');
        if (!pending)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        pending = false;
        signal.throwIfAborted();
      },
      close,
    };
  }
}
