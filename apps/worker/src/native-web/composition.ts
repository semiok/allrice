import type {
  PersonVmBinding,
  PersonVmBootstrapScope,
  PersonVmPort,
  PersonVmRuntimePort,
  PersonVmWebEndpointReceipt,
  PersonVmWebStartup,
  PersonVmWebRosterPort,
} from '@allrice/person-vm';
import { PersonVmError, sameVmBinding } from '@allrice/person-vm';
import { preparePersonNativeWebRoster } from '@allrice/database';
import {
  prepareNativeWebLaunch,
  type NativeWebConfiguration,
  type NativeWebLaunch,
} from './launch.js';
import { openNativeWebOwner, type NativeWebOwner } from './owner.js';

type Endpoint = PersonVmWebEndpointReceipt['endpoints'][number];
/** Bind the real database producer; cancellation still joins its SQL operation. */
export const personNativeWebRoster: PersonVmWebRosterPort = {
  async prepare(context, signal) {
    signal.throwIfAborted();
    const roster = await preparePersonNativeWebRoster(context);
    signal.throwIfAborted();
    return roster;
  },
};
/** Actual startup component, not editor readiness or a new HTTP listener.
 * The production composition must supply the public MET267 plan and trusted
 * ingress configuration; no missing dependency is replaced by a dummy plan. */
export function createAssignedNativeWebStartup(input: {
  vm: Pick<PersonVmPort, 'assertCurrentBinding'>;
  memoryGuestPlan: PersonVmRuntimePort['memoryGuestPlan'];
  configuration: Pick<
    NativeWebConfiguration,
    'cliPath' | 'guestAddress' | 'startupTimeoutMs'
  > & {
    publicUrl(endpoint: Endpoint, binding: PersonVmBinding): string;
  };
  lifetime: AbortSignal;
  cleanupTimeoutMs: number;
}) {
  const prepared = new WeakMap<
    PersonVmWebStartup,
    readonly NativeWebLaunch[]
  >();
  const running = new Map<
    string,
    {
      binding: PersonVmBinding;
      owners: Map<string, NativeWebOwner>;
      starting: Promise<void>;
      retiring?: Promise<void>;
      unjoinedOpen: boolean;
    }
  >();
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  function track<T>(work: () => Promise<T>) {
    const operation = Promise.resolve().then(work);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  }
  function current(binding: PersonVmBinding, web?: PersonVmWebStartup) {
    lifetime.throwIfAborted();
    if (
      closing ||
      !web ||
      !sameVmBinding(web.receipt.binding, binding) ||
      web.context.actor.type !== 'user' ||
      web.context.actor.id !== binding.personId ||
      web.context.organizationId !== binding.organizationId
    )
      throw new PersonVmError('LEASE_LOST');
    return web;
  }
  async function close() {
    if (closing) return closing;
    stopped.abort(new PersonVmError('LEASE_LOST'));
    closing = (async () => {
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled(
        [...running.values()].flatMap((group) =>
          [...group.owners.values()].map((owner) => owner.close()),
        ),
      );
      if (
        [...running.values()].some((group) => group.unjoinedOpen) ||
        results.some((result) => result.status === 'rejected')
      )
        throw new PersonVmError('CLEANUP_INCOMPLETE');
      running.clear();
    })();
    return closing;
  }
  const abort = () => {
    void close().catch(() => {});
  };
  input.lifetime.addEventListener('abort', abort, { once: true });
  if (input.lifetime.aborted) abort();
  return {
    memoryGuestPlan(
      binding: PersonVmBinding,
      signal: AbortSignal,
      startup?: PersonVmWebStartup,
    ) {
      return track(async () => {
        const web = current(binding, startup);
        signal = AbortSignal.any([signal, lifetime]);
        signal.throwIfAborted();
        const memory = await input.memoryGuestPlan(binding, signal);
        const launches = await Promise.all(
          web.receipt.endpoints.map((endpoint) => {
            const home = `/work/.allrice/employees/${endpoint.employeeInstanceId}`;
            return prepareNativeWebLaunch(
              {
                ...input.configuration,
                origin: `http://127.0.0.1:${endpoint.hostPort}/`,
                publicUrl: input.configuration.publicUrl(endpoint, binding),
                guestPort: endpoint.guestPort,
                dshHome: `${home}/dsh`,
                agentsHome: `${home}/agents`,
                workdir: '/work',
              },
              binding,
            );
          }),
        );
        current(binding, web);
        signal.throwIfAborted();
        prepared.set(web, launches);
        // The existing native bootstrap stages all files, initializes person
        // memory once, and only then exposes its launcher to start below.
        return {
          ...memory,
          files: [
            ...memory.files,
            ...launches.flatMap((launch) => launch.files),
          ],
        };
      });
    },
    start(
      binding: PersonVmBinding,
      signal: AbortSignal,
      scope: PersonVmBootstrapScope,
      startup?: PersonVmWebStartup,
    ) {
      const operation: Promise<void> = track(async () => {
        const web = current(binding, startup),
          launches = prepared.get(web);
        if (!sameVmBinding(scope.binding, binding))
          throw new PersonVmError('LEASE_LOST');
        signal = AbortSignal.any([signal, scope.signal, lifetime]);
        if (!launches || running.has(binding.vmId))
          throw new PersonVmError('LEASE_CONFLICT');
        prepared.delete(web);
        const group = {
          binding,
          owners: new Map<string, NativeWebOwner>(),
          starting: operation,
          retiring: undefined as Promise<void> | undefined,
          unjoinedOpen: false,
        };
        running.set(binding.vmId, group);
        try {
          for (const [index, launch] of launches.entries()) {
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
            current(binding, web);
            signal.throwIfAborted();
            await scope.assertCurrent();
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
            const owner = await openNativeWebOwner({
              scope,
              launch,
              context: web.context,
              vm: input.vm,
              lifetime,
              cleanupTimeoutMs: input.cleanupTimeoutMs,
            });
            group.owners.set(
              web.receipt.endpoints[index]!.employeeInstanceId,
              owner,
            );
            current(binding, web);
            signal.throwIfAborted();
            if (group.retiring) throw new PersonVmError('LEASE_LOST');
          }
        } catch (error) {
          group.unjoinedOpen =
            error instanceof PersonVmError &&
            error.code === 'CLEANUP_INCOMPLETE';
          const joined = await Promise.allSettled(
            [...group.owners.values()].map((owner) => owner.close()),
          );
          if (joined.some((result) => result.status === 'rejected'))
            throw new PersonVmError('CLEANUP_INCOMPLETE', { cause: error });
          // An open that could not join its own resources cannot be certified
          // by the successfully returned owners. Keep that unknown group.
          if (!group.unjoinedOpen && !group.retiring)
            running.delete(binding.vmId);
          throw error;
        }
      });
      return operation;
    },
    retireAfterNativeStop(binding: PersonVmBinding, signal: AbortSignal) {
      const group = running.get(binding.vmId);
      if (!group) return Promise.resolve();
      if (!sameVmBinding(group.binding, binding))
        return Promise.reject(new PersonVmError('LEASE_LOST'));
      if (group.retiring) return group.retiring;
      const operation = (async () => {
        signal.throwIfAborted();
        await Promise.allSettled([group.starting]);
        const joined = await Promise.allSettled(
          [...group.owners.values()].map((owner) =>
            owner.retireAfterNativeStop(binding, signal),
          ),
        );
        if (
          group.unjoinedOpen ||
          joined.some((result) => result.status === 'rejected')
        )
          throw new PersonVmError('CLEANUP_INCOMPLETE');
        signal.throwIfAborted();
        if (running.get(binding.vmId) !== group)
          throw new PersonVmError('LEASE_LOST');
        running.delete(binding.vmId);
      })();
      group.retiring = operation;
      void operation.catch(() => {
        if (group.retiring === operation) group.retiring = undefined;
      });
      return operation;
    },
    /** Host catalog resource only. Its read method still rechecks VM authority.
     * It supplies no editor/send proof, native ancestry pin or browser credential. */
    owner(binding: PersonVmBinding, employeeInstanceId: string) {
      lifetime.throwIfAborted();
      if (closing) throw new PersonVmError('LEASE_LOST');
      const group = running.get(binding.vmId);
      if (!group || group.retiring || !sameVmBinding(group.binding, binding))
        throw new PersonVmError('LEASE_LOST');
      return group.owners.get(employeeInstanceId);
    },
    async close() {
      try {
        await close();
      } finally {
        input.lifetime.removeEventListener('abort', abort);
      }
    },
  } satisfies Pick<
    PersonVmRuntimePort,
    'memoryGuestPlan' | 'start' | 'retireAfterNativeStop'
  > & {
    owner(
      binding: PersonVmBinding,
      employeeInstanceId: string,
    ): NativeWebOwner | undefined;
    close(): Promise<void>;
  };
}
