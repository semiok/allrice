import { PersonVmError } from './contract.ts';
import type { PersonVmBinding } from './contract.ts';
import type {
  PersonVmNativeResourceFacts,
  PersonVmNativeResourcePort,
  PersonVmNativeResourceSubscription,
  PersonVmResourceLifecyclePort,
  PersonVmResourceLifecycleWatch,
  PersonVmResourcePort,
} from './resource-contract.ts';

const key = (binding: PersonVmBinding) =>
  JSON.stringify([
    binding.vmId,
    binding.personId,
    binding.organizationId,
    binding.instanceId,
    binding.leaseEpoch,
  ]);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const quantity = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && (value as number) >= 0);

/** Consumer only: actual authority/lifecycle and resource event sources are
 * mandatory. No long-lived admission permit, physical lease or polling. */
export function createPersonVmResourcePort(input: {
  lifecycle: PersonVmResourceLifecyclePort;
  native: PersonVmNativeResourcePort;
}): PersonVmResourcePort {
  if (
    typeof input?.lifecycle?.watch !== 'function' ||
    typeof input?.native?.subscribe !== 'function' ||
    typeof input?.native?.read !== 'function'
  )
    throw new PersonVmError('RUNTIME_NOT_READY');

  return {
    async watch(context, bindingInput, signal) {
      signal.throwIfAborted();
      const binding = Object.freeze({ ...bindingInput });
      const bindingKey = key(binding);
      const owned = new AbortController();
      const watching = AbortSignal.any([signal, owned.signal]);
      let lifecycle: PersonVmResourceLifecycleWatch | undefined;
      let native: PersonVmNativeResourceSubscription | undefined;
      let closed = false;
      let closing: Promise<void> | undefined;
      let cache: PersonVmNativeResourceFacts | null = null;
      let cachedAt: readonly [string, string] | undefined;
      let generation = 0;
      let dirty = false;
      let refreshing: Promise<void> | undefined;
      let reading: AbortController | undefined;
      let pending = false;
      const waiters = new Set<() => void>();
      const work = new Set<Promise<void>>();
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
      const invalidate = () => {
        cache = null;
        cachedAt = undefined;
        generation++;
        reading?.abort();
        notify();
      };
      const dispose = () => {
        for (const source of [lifecycle, native]) {
          if (source && !disposals.has(source)) {
            const task = Promise.resolve().then(() => source.close());
            disposals.set(source, task);
            // Keep the rejection for close(), without an unhandled rejection.
            void task.catch(() => {});
          }
        }
      };
      const close = () => {
        if (closing) return closing;
        let resolve!: () => void, reject!: (cause: unknown) => void;
        // Publish the barrier before abort/disposers can reenter close().
        closing = new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        closed = true;
        invalidate();
        signal.removeEventListener('abort', onAbort);
        owned.abort(signal.reason);
        dispose();
        void (async () => {
          await setup;
          dispose();
          const results = await Promise.allSettled([
            ...disposals.values(),
            ...work,
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
      const current = (): readonly [string, string] | null => {
        if (closed || watching.aborted) return null;
        try {
          const before = lifecycle?.read();
          const resourceRevision = native?.read();
          const after = lifecycle?.read();
          if (
            !before ||
            !after ||
            key(before.binding) !== bindingKey ||
            key(after.binding) !== bindingKey ||
            !text(before.revision) ||
            before.revision !== after.revision ||
            !text(before.evidenceRef) ||
            !text(after.evidenceRef) ||
            !text(resourceRevision)
          )
            return null;
          return [before.revision, resourceRevision];
        } catch {
          return null;
        }
      };
      const same = (
        left: readonly [string, string] | null | undefined,
        right: readonly [string, string] | null | undefined,
      ) => !!left && !!right && left[0] === right[0] && left[1] === right[1];
      const snapshot = (
        facts: PersonVmNativeResourceFacts,
        revision: string,
      ): PersonVmNativeResourceFacts | null => {
        try {
          if (
            key(facts.binding) !== bindingKey ||
            facts.revision !== revision ||
            !text(facts.evidenceRef) ||
            !Number.isSafeInteger(facts.physical.configuredBytes) ||
            facts.physical.configuredBytes <= 0 ||
            ![
              facts.host.vmRssBytes,
              facts.host.helperRssBytes,
              facts.host.swapBytes,
            ].every(quantity)
          )
            return null;
          if (facts.physical.state === 'verified') {
            if (
              !Number.isSafeInteger(facts.physical.enforcedBytes) ||
              facts.physical.enforcedBytes <= 0 ||
              !text(facts.physical.sourceRef)
            )
              return null;
          } else if (
            facts.physical.state !== 'unknown' ||
            !text(facts.physical.reason)
          )
            return null;
          return Object.freeze({
            ...facts,
            binding,
            physical: Object.freeze({ ...facts.physical }),
            host: Object.freeze({ ...facts.host }),
          });
        } catch {
          return null;
        }
      };
      const retain = (task: Promise<void>) => {
        work.add(task);
        void task.then(
          () => work.delete(task),
          () => work.delete(task),
        );
        return task;
      };
      const refresh = () => {
        if (closed || refreshing) return refreshing;
        const task = (async () => {
          while (dirty && !closed) {
            dirty = false;
            const at = current();
            if (!at) continue;
            const turn = generation;
            const controller = new AbortController();
            reading = controller;
            try {
              const facts = await input.native.read(
                binding,
                AbortSignal.any([watching, controller.signal]),
              );
              if (
                !closed &&
                !controller.signal.aborted &&
                turn === generation &&
                same(at, current())
              ) {
                cache = snapshot(facts, at[1]);
                cachedAt = cache ? at : undefined;
                notify();
              }
            } catch {
              // No retry without a new source event; unavailable is never idle.
              if (!closed && turn === generation) invalidate();
            } finally {
              if (reading === controller) reading = undefined;
            }
          }
        })();
        refreshing = retain(task);
        void task.then(() => {
          refreshing = undefined;
          if (dirty && !closed) refresh();
        });
        return task;
      };
      const changed = () => {
        if (closed) return;
        invalidate();
        dirty = true;
        refresh();
      };
      const pump = (source: { wait(): Promise<void> }) =>
        retain(
          (async () => {
            try {
              while (!closed) {
                await source.wait();
                if (!closed) changed();
              }
            } catch {
              // Do not await a barrier which joins this pump itself.
              void close().catch(() => {});
            }
          })(),
        );

      signal.addEventListener('abort', onAbort, { once: true });
      let setupFailed = false;
      let setupError: unknown;
      try {
        lifecycle = await input.lifecycle.watch(context, binding, watching);
        if (closed || watching.aborted) {
          dispose();
          watching.throwIfAborted();
        }
        native = await input.native.subscribe(binding, watching);
        if (closed || watching.aborted) {
          dispose();
          watching.throwIfAborted();
        }
        pump(lifecycle);
        pump(native);
        dirty = true;
        await refresh();
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
        throw new PersonVmError('RUNTIME_NOT_READY');
      }
      return {
        read() {
          if (closed || watching.aborted) return null;
          if (!same(cachedAt, current())) {
            // Also refuse synchronously before a queued notification is handled.
            if (cache) changed();
            return null;
          }
          return cache;
        },
        async wait() {
          signal.throwIfAborted();
          if (closed) return;
          if (pending) pending = false;
          else await new Promise<void>((resolve) => waiters.add(resolve));
          signal.throwIfAborted();
        },
        close,
      };
    },
  };
}
