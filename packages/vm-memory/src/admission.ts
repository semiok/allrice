import type { PersonVmBinding } from '@allrice/person-vm';
import { VM_PHYSICAL_MEMORY_BYTES, VmMemoryError } from './contract.ts';
import type { VmMemoryAdmissionPort, VmMemorySource } from './contract.ts';

const bindingKey = (binding: PersonVmBinding) =>
  JSON.stringify([
    binding.vmId,
    binding.personId,
    binding.organizationId,
    binding.instanceId,
    binding.leaseEpoch,
  ]);
const quantity = (value: number | null) =>
  value === null || (Number.isSafeInteger(value) && value >= 0);

/** An external resource gate only. DSH still owns the turn/tool/session lifecycle.
 * There is no timer, queue limit, pressure threshold or default-open source. */
export function createVmMemoryAdmission(
  source: VmMemorySource,
): VmMemoryAdmissionPort {
  return {
    async watch(bindingInput, signal) {
      signal.throwIfAborted();
      // Keep the exact host epoch even if a caller mutates its original object.
      const binding = Object.freeze({ ...bindingInput });
      const key = bindingKey(binding);
      let watch;
      try {
        watch = await source.watch(binding, signal);
      } catch (cause) {
        signal.throwIfAborted();
        throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE', { cause });
      }
      let closed = false;
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= (async () => {
          closed = true;
          signal.removeEventListener('abort', onAbort);
          await watch.close();
        })());
      const onAbort = () => {
        void close().catch(() => {
          /* caller awaits close */
        });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        await close();
        signal.throwIfAborted();
      }
      return {
        read() {
          signal.throwIfAborted();
          if (closed) throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
          try {
            const observation = watch.read();
            if (
              !observation ||
              observation.pressure === 'unavailable' ||
              !observation.revision.trim() ||
              !observation.evidenceRef.trim() ||
              ![
                observation.host.vmRssBytes,
                observation.host.helperRssBytes,
                observation.host.swapBytes,
              ].every(quantity)
            )
              throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
            if (bindingKey(observation.binding) !== key)
              throw new VmMemoryError('MEMORY_BINDING_INVALID');
            if (
              observation.physical.configuredBytes !==
                VM_PHYSICAL_MEMORY_BYTES ||
              observation.physical.enforcedBytes !== VM_PHYSICAL_MEMORY_BYTES
            )
              throw new VmMemoryError('VM_MEMORY_CAP_INVALID');
            if (!['normal', 'pressure'].includes(observation.pressure))
              throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
            // Guest counters are retained for diagnostics, never evaluated here.
            return observation.pressure === 'normal' ? 'ready' : 'queued';
          } catch (cause) {
            if (cause instanceof VmMemoryError) throw cause;
            throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE', {
              cause,
            });
          }
        },
        async wait() {
          signal.throwIfAborted();
          if (closed) throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
          await watch.wait();
          signal.throwIfAborted();
          if (closed) throw new VmMemoryError('MEMORY_OBSERVATION_UNAVAILABLE');
        },
        close,
      };
    },
  };
}
