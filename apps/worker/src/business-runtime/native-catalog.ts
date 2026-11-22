import type { RequestContext } from '@allrice/contracts';
import { sameDEntryIdentity } from '@allrice/contracts';
import {
  DataAccessError,
  readPersonNativeWebRoster,
  requireDEntryNativeIdentity,
} from '@allrice/database';
import type { PersonVmBinding, PersonVmPort } from '@allrice/person-vm';
import type { createAssignedNativeWebStartup } from '../native-web/composition.js';
import {
  DEntryNativeUnavailable,
  dEntryOwnerViewSchema,
  installDEntryNativeOwnerPort,
  sameDEntryVmBinding,
  type DEntryNativeOwnerPort,
  type ResolvedDEntryNativeOwner,
} from '../d-entry/native-owner.js';

type Endpoint = ResolvedDEntryNativeOwner['endpoint'];
export type CurrentNativeCatalogRoster = Readonly<{
  personId: string;
  organizationId: string;
  digest: string;
  entries: readonly Pick<
    Endpoint,
    | 'workspaceId'
    | 'employeeInstanceId'
    | 'employeeRevision'
    | 'employeeVersionId'
  >[];
}>;
/** The existing startup owner publishes this exact receipt, never a guest DTO. */
export type PublishedNativeCatalog = Readonly<{
  receipt: ResolvedDEntryNativeOwner['receipt'];
  endpoint: Endpoint;
  bindingRef: string;
  revoked: AbortSignal;
  owner: Readonly<{
    revoked: AbortSignal;
    controlReady(): boolean;
    readSessionsFor(
      context: RequestContext,
      signal: AbortSignal,
    ): ReturnType<ResolvedDEntryNativeOwner['readSessions']>;
  }>;
}>;
/** Required trusted producers. No start/prewarm, generic RPC or history port. */
export type NativeCatalogHost = Readonly<{
  vm: Pick<PersonVmPort, 'resolve' | 'assertCurrentBinding'>;
  readRoster(
    context: RequestContext,
    signal: AbortSignal,
  ): Promise<CurrentNativeCatalogRoster>;
  catalog(
    binding: PersonVmBinding,
    employeeInstanceId: string,
  ): PublishedNativeCatalog | undefined;
}>;

const deny = (): never => {
  throw new DataAccessError('authorization_denied');
};
const employeeKeys = [
  'workspaceId',
  'employeeInstanceId',
  'employeeRevision',
  'employeeVersionId',
] as const;

/** Compose actual current authority with an already started Session catalog.
 * The caller still owns native lifetime and production Host construction. */
export function createDEntryNativeCatalogPort(input: {
  host: NativeCatalogHost;
  lifetime: AbortSignal;
}) {
  input.lifetime.throwIfAborted();
  if (!input.host) throw new DEntryNativeUnavailable();
  const stopped = new AbortController();
  const lifetime = AbortSignal.any([input.lifetime, stopped.signal]);
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  function own<T>(work: () => Promise<T>): Promise<T> {
    if (lifetime.aborted) return Promise.reject(lifetime.reason);
    const task = Promise.resolve().then(work);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  const port: DEntryNativeOwnerPort = {
    resolve(context, identity, caller) {
      return own(async () => {
        const selection = {
          workspaceId: identity.workspaceId,
          employeeInstanceId: identity.employeeInstanceId,
          ...(identity.threadId ? { threadId: identity.threadId } : {}),
        };
        const signal = AbortSignal.any([caller, lifetime]);
        let binding: PersonVmBinding | undefined;
        let published: PublishedNativeCatalog | undefined;
        async function current(who: RequestContext, active: AbortSignal) {
          active.throwIfAborted();
          const next = await requireDEntryNativeIdentity(who, selection);
          active.throwIfAborted();
          if (!sameDEntryIdentity(identity, next)) deny();
          if (!binding) binding = await input.host.vm.resolve(who, active);
          else await input.host.vm.assertCurrentBinding(who, binding, active);
          active.throwIfAborted();
          const roster = await input.host.readRoster(who, active);
          active.throwIfAborted();
          const found = input.host.catalog(
            binding,
            identity.employeeInstanceId,
          );
          if (!found) throw new DEntryNativeUnavailable();
          const view = dEntryOwnerViewSchema.parse({
            receipt: found.receipt,
            endpoint: found.endpoint,
            bindingRef: found.bindingRef,
            controlReady: found.owner.controlReady(),
          });
          const selected = view.receipt.endpoints.filter((endpoint) =>
            employeeKeys.every((key) => endpoint[key] === identity[key]),
          );
          if (
            roster.personId !== identity.personId ||
            roster.organizationId !== identity.organizationId ||
            roster.digest !== view.receipt.rosterDigest ||
            !sameDEntryVmBinding(binding, view.receipt.binding) ||
            binding.personId !== identity.personId ||
            binding.organizationId !== identity.organizationId ||
            selected.length !== 1 ||
            JSON.stringify(selected[0]) !== JSON.stringify(view.endpoint) ||
            !roster.entries.some((endpoint) =>
              employeeKeys.every((key) => endpoint[key] === identity[key]),
            ) ||
            (published &&
              (published.receipt !== found.receipt ||
                published.endpoint !== found.endpoint ||
                published.owner !== found.owner ||
                published.bindingRef !== found.bindingRef))
          )
            deny();
          active.throwIfAborted();
          found.revoked.throwIfAborted();
          found.owner.revoked.throwIfAborted();
          published = found;
          return view;
        }
        const view = await current(context, signal);
        const owner = published!;
        const revoked = AbortSignal.any([
          lifetime,
          owner.revoked,
          owner.owner.revoked,
        ]);
        return Object.freeze({
          receipt: view.receipt,
          endpoint: view.endpoint,
          bindingRef: view.bindingRef,
          revoked,
          controlReady: () => !revoked.aborted && owner.owner.controlReady(),
          assertCurrent(who: RequestContext, checking: AbortSignal) {
            return own(async () => {
              await current(who, AbortSignal.any([checking, revoked]));
              context = who;
            });
          },
          readSessions(reading: AbortSignal) {
            return own(async () => {
              const who = context;
              const active = AbortSignal.any([reading, revoked]);
              await current(who, active);
              const result = await owner.owner.readSessionsFor(who, active);
              await current(who, active);
              return result;
            });
          },
        }) satisfies ResolvedDEntryNativeOwner;
      });
    },
  };
  return {
    port,
    close() {
      if (closing) return closing;
      stopped.abort(new DEntryNativeUnavailable());
      // Await actual guards/SQL/native reads; this does not close the shared VM.
      closing = Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  };
}

/** Production composition installs only after it has a real complete Host.
 * Absent Host construction leaves 271's original uninstalled default intact. */
export function installDEntryNativeCatalog(input: {
  host: NativeCatalogHost;
  lifetime: AbortSignal;
}) {
  const assembly = createDEntryNativeCatalogPort(input);
  let uninstall: () => void;
  try {
    uninstall = installDEntryNativeOwnerPort(assembly.port);
  } catch (error) {
    void assembly.close();
    throw error;
  }
  const close = () => {
    uninstall();
    input.lifetime.removeEventListener('abort', abort);
    return assembly.close();
  };
  const abort = () => {
    void close();
  };
  input.lifetime.addEventListener('abort', abort, { once: true });
  if (input.lifetime.aborted) abort();
  return { close };
}

/** Bind the real readonly SQL producer and actual already-started native group.
 * Production still supplies its real VM/startup owners and lifetime. */
export function installAssignedDEntryNativeCatalog(input: {
  vm: NativeCatalogHost['vm'];
  startup: Pick<ReturnType<typeof createAssignedNativeWebStartup>, 'catalog'>;
  lifetime: AbortSignal;
}) {
  return installDEntryNativeCatalog({
    lifetime: input.lifetime,
    host: {
      vm: input.vm,
      catalog: (binding, employeeInstanceId) =>
        input.startup.catalog(binding, employeeInstanceId),
      async readRoster(context, signal) {
        signal.throwIfAborted();
        const roster = await readPersonNativeWebRoster(context);
        signal.throwIfAborted();
        return roster;
      },
    },
  });
}
