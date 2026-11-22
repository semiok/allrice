import type {
  PersonVmBinding,
  PersonVmNativeResourceFacts,
  PersonVmResourcePort,
  PersonVmResourceWatch,
} from '@allrice/person-vm';
import { VmMemoryError } from './contract.ts';
import type { VmMemoryObservation, VmMemorySource } from './contract.ts';

/** Trusted host policy output, never guest JSON. References identify evidence;
 * their presence alone does not authenticate a source or approve its policy. */
export type VmMemoryHostPressureObservation = Readonly<{
  binding: PersonVmBinding;
  /** Changes with the pressure facts, policy or availability; never a TTL. */
  revision: string;
  evidenceRef: string;
  policyRef: string;
  pressure: 'normal' | 'pressure' | 'unavailable';
}>;

export interface VmMemoryHostPressureWatch {
  /** Null immediately on disconnect, loss of attribution or policy availability. */
  read(): VmMemoryHostPressureObservation | null;
  /** Buffered source notifications, including invalidation/reconnect. */
  wait(): Promise<void>;
  /** Cancel, detach, settle wait and join actual owned work. */
  close(): Promise<void>;
}

export interface VmMemoryHostPressurePort {
  watch(
    binding: PersonVmBinding,
    signal: AbortSignal,
  ): Promise<VmMemoryHostPressureWatch>;
}

const key = (binding: PersonVmBinding) =>
  JSON.stringify([
    binding.vmId,
    binding.personId,
    binding.organizationId,
    binding.instanceId,
    binding.leaseEpoch,
  ]);
const text = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0;
const quantity = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 0);

/** Joins two real injected sources. It produces no native facts or pressure
 * policy, and cannot be constructed without both source capabilities. */
export function createVmMemoryHostSource(input: {
  context: Parameters<PersonVmResourcePort['watch']>[0];
  resources: PersonVmResourcePort;
  pressure: VmMemoryHostPressurePort;
}): VmMemorySource {
  if (
    typeof input?.resources?.watch !== 'function' ||
    typeof input?.pressure?.watch !== 'function'
  )
    throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');

  return {
    async watch(bindingInput, signal) {
      signal.throwIfAborted();
      const binding = Object.freeze({ ...bindingInput });
      const bindingKey = key(binding);
      const owned = new AbortController();
      const watching = AbortSignal.any([signal, owned.signal]);
      let resources: PersonVmResourceWatch | undefined;
      let pressure: VmMemoryHostPressureWatch | undefined;
      let closed = false;
      let closing: Promise<void> | undefined;
      let pending = false;
      const waiters = new Set<() => void>();
      const pumps: Promise<void>[] = [];
      const disposals = new Map<object, Promise<void>>();
      let setupFinished!: () => void;
      const setup = new Promise<void>((resolve) => {
        setupFinished = resolve;
      });
      const notify = () => {
        pending = waiters.size === 0;
        for (const resolve of waiters) resolve();
        waiters.clear();
      };
      const dispose = () => {
        for (const source of [resources, pressure]) {
          if (source && !disposals.has(source)) {
            const task = Promise.resolve().then(() => source.close());
            disposals.set(source, task);
            void task.catch(() => {});
          }
        }
      };
      const close = () => {
        if (closing) return closing;
        let resolve!: () => void, reject!: (cause: unknown) => void;
        // Set the barrier before cancellation/disposers can reenter.
        closing = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        closed = true;
        notify();
        signal.removeEventListener('abort', onAbort);
        owned.abort(signal.reason);
        dispose();
        void (async () => {
          await setup;
          dispose();
          const results = await Promise.allSettled([
            ...disposals.values(),
            ...pumps,
          ]);
          const failure = results.find(
            (result) => result.status === 'rejected',
          );
          if (failure?.status === 'rejected') reject(failure.reason);
          else resolve();
        })();
        return closing;
      };
      const onAbort = () => {
        void close().catch(() => {});
      };
      const pump = (source: { wait(): Promise<void> }) => {
        pumps.push(
          (async () => {
            try {
              // One pending wait per source, without losing race waiters.
              while (!closed) {
                await source.wait();
                if (!closed) notify();
              }
            } catch {
              void close().catch(() => {});
            }
          })(),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      let setupFailed = false;
      let setupError: unknown;
      try {
        resources = await input.resources.watch(
          input.context,
          binding,
          watching,
        );
        if (closed || watching.aborted) {
          dispose();
          watching.throwIfAborted();
        }
        pressure = await input.pressure.watch(binding, watching);
        if (closed || watching.aborted) {
          dispose();
          watching.throwIfAborted();
        }
        pump(resources);
        pump(pressure);
        watching.throwIfAborted();
      } catch (cause) {
        setupFailed = true;
        setupError = cause;
      } finally {
        setupFinished();
      }
      if (setupFailed || closed || watching.aborted) {
        await close();
        signal.throwIfAborted();
        if (setupFailed) throw setupError;
        throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
      }

      const observation = (): VmMemoryObservation | null => {
        if (closed || watching.aborted) return null;
        try {
          const facts: PersonVmNativeResourceFacts | null = resources!.read();
          const host = pressure!.read();
          const after = resources!.read();
          const hostAfter = pressure!.read();
          if (
            !facts ||
            !host ||
            !after ||
            !hostAfter ||
            facts.revision !== after.revision ||
            host.revision !== hostAfter.revision ||
            ![facts, after, host, hostAfter].every(
              (value) => key(value.binding) === bindingKey,
            ) ||
            ![
              facts.revision,
              facts.evidenceRef,
              host.revision,
              host.evidenceRef,
              host.policyRef,
            ].every(text) ||
            !['normal', 'pressure'].includes(host.pressure) ||
            facts.physical.state !== 'verified' ||
            !text(facts.physical.sourceRef) ||
            !Number.isSafeInteger(facts.physical.configuredBytes) ||
            facts.physical.configuredBytes <= 0 ||
            !Number.isSafeInteger(facts.physical.enforcedBytes) ||
            facts.physical.enforcedBytes <= 0 ||
            ![
              facts.host.vmRssBytes,
              facts.host.helperRssBytes,
              facts.host.swapBytes,
            ].every(quantity)
          )
            return null;
          return Object.freeze({
            binding,
            revision: JSON.stringify([
              facts.revision,
              host.revision,
              host.policyRef,
            ]),
            evidenceRef: JSON.stringify([
              facts.evidenceRef,
              facts.physical.sourceRef,
              host.evidenceRef,
              host.policyRef,
            ]),
            pressure: host.pressure as 'normal' | 'pressure',
            physical: Object.freeze({
              configuredBytes: facts.physical.configuredBytes,
              enforcedBytes: facts.physical.enforcedBytes,
            }),
            host: Object.freeze({ ...facts.host }),
            guest: null,
          });
        } catch {
          return null;
        }
      };
      return {
        read: observation,
        async wait() {
          signal.throwIfAborted();
          if (closed) throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
          if (pending) pending = false;
          else await new Promise<void>((resolve) => waiters.add(resolve));
          signal.throwIfAborted();
          if (closed) throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
        },
        close,
      };
    },
  };
}
