import {
  sameDEntryIdentity,
  type HostHistoryBinding,
  type RequestContext,
} from '@allrice/contracts';
import { DataAccessError, type DEntryHistoryRootPin } from '@allrice/database';
import {
  hostHistoryDigest,
  HostHistoryIntegrityError,
  type CommittedHostHistorySource,
  type HostHistorySourceKey,
  type HostHistorySourceStore,
} from '@allrice/storage';
import type { DEntryNativeResource } from './native-resource';
import type { DEntryHistoryPorts } from './history';
import { DEntryDependencyUnavailable } from './release-policy';

/** Construct ONCE PER REQUEST beside the existing 271 authority/watch. No live
 * VM lease, native client, prewarm, Agent, independent watcher or permission
 * cache exists here. The same selected manifest spans every download recheck. */
export function createColdHistorySource(input: {
  sources: HostHistorySourceStore;
  signal: AbortSignal;
  /** Existing parseDEntryHistoryRequest output, before the first resolution.
   * A requested digest selects a committed cut; it never grants authority. */
  selection?: Readonly<{ nativeSessionId: string; snapshotDigest?: string }>;
}) {
  const selection = input.selection && { ...input.selection };
  const closed = new AbortController();
  const operations = new Set<Promise<unknown>>();
  let selected: Promise<CommittedHostHistorySource> | undefined;
  let original: DEntryHistoryRootPin | undefined;
  let caller: string | undefined;
  let authority: AbortSignal | undefined;
  let closing: Promise<void> | undefined;
  let accepting = true;
  const fail: () => never = () => {
    throw new DataAccessError('authorization_denied');
  };
  const check = (signal: AbortSignal) =>
    AbortSignal.any([input.signal, closed.signal, signal]);
  const own = <T>(work: () => Promise<T>): Promise<T> => {
    if (!accepting)
      return Promise.reject(new DataAccessError('authorization_denied'));
    const operation = Promise.resolve().then(work);
    operations.add(operation);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
    return operation;
  };
  const readSelection = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!selected) fail();
    const value = await selected;
    signal.throwIfAborted();
    return value;
  };
  const reference = (
    source: CommittedHostHistorySource,
    binding: HostHistoryBinding,
  ) =>
    binding.parentNativeSessionId === null
      ? original!.rootBindingRef
      : hostHistoryDigest({ sourceDigest: source.digest, binding });
  const bindingFor = async (
    resource: DEntryNativeResource,
    signal: AbortSignal,
  ) => {
    const source = await readSelection(signal);
    const row = source.manifest.sessions.find(
      ({ binding: b }) =>
        b.organizationId === resource.organizationId &&
        b.personId === resource.personId &&
        b.employeeInstanceId === resource.employeeInstanceId &&
        b.threadId === resource.threadId &&
        b.nativeSessionId === resource.nativeSessionId &&
        b.rootNativeSessionId === resource.rootNativeSessionId &&
        b.parentNativeSessionId === resource.parentNativeSessionId &&
        reference(source, b) === resource.bindingRef,
    );
    if (!row) fail();
    return row.binding;
  };
  const binding: DEntryHistoryPorts['binding'] = (resource, signal) =>
    own(async () =>
      bindingFor(resource, check(AbortSignal.any([signal, resource.revoked]))),
    );
  const store: DEntryHistoryPorts['store'] = {
    async publish() {
      throw new HostHistoryIntegrityError();
    },
    read(binding, signal, digest) {
      return own(async () => {
        const active = check(
          AbortSignal.any([signal, ...(authority ? [authority] : [])]),
        );
        const source = await readSelection(active);
        // The adapter always sends the manifest's exact digest to the raw
        // store. Its original full integrity scan remains fail closed.
        return input.sources
          .committedStore(source)
          .read(binding, active, digest);
      });
    },
  };
  return {
    binding,
    store,
    resolveColdResource(
      context: RequestContext,
      root: DEntryHistoryRootPin,
      nativeSessionId: string,
      signal: AbortSignal,
    ): Promise<DEntryNativeResource> {
      return own(async () => {
        const active = check(signal);
        active.throwIfAborted();
        if (selection && selection.nativeSessionId !== nativeSessionId) fail();
        const identity = root.identity;
        if (
          !identity.threadId ||
          context.organizationId !== identity.organizationId ||
          context.workspaceId !== identity.workspaceId
        )
          fail();
        const callerKey = JSON.stringify([
          context.organizationId,
          context.workspaceId,
          context.actor.id,
          context.sessionId,
        ]);
        if (
          original &&
          (!sameDEntryIdentity(original.identity, identity) ||
            (
              [
                'rootNativeSessionId',
                'rootOriginDigest',
                'rootBindingRef',
                'vmId',
              ] as const
            ).some((field) => original![field] !== root[field]) ||
            caller !== callerKey)
        )
          fail();
        if (!selected) {
          original = structuredClone(root);
          caller = callerKey;
          authority = signal;
          const key: HostHistorySourceKey = {
            organizationId: identity.organizationId,
            workspaceId: identity.workspaceId,
            personId: identity.personId,
            employeeInstanceId: identity.employeeInstanceId,
            threadId: identity.threadId,
            rootNativeSessionId: root.rootNativeSessionId,
            rootOriginDigest: root.rootOriginDigest,
            rootBindingRef: root.rootBindingRef,
            vmId: root.vmId,
          };
          selected = input.sources
            .read(
              key,
              active,
              selection?.snapshotDigest
                ? {
                    nativeSessionId: selection.nativeSessionId,
                    snapshotDigest: selection.snapshotDigest,
                  }
                : undefined,
            )
            .then((source) => {
              active.throwIfAborted();
              if (!source)
                throw new DEntryDependencyUnavailable('native-route');
              return source;
            });
        }
        const source = await readSelection(active);
        const row = source.manifest.sessions.find(
          (row) => row.binding.nativeSessionId === nativeSessionId,
        );
        if (!row) throw new DataAccessError('not_found');
        const b = row.binding;
        return {
          organizationId: b.organizationId,
          personId: b.personId,
          employeeInstanceId: b.employeeInstanceId,
          threadId: b.threadId,
          nativeSessionId: b.nativeSessionId,
          rootNativeSessionId: b.rootNativeSessionId,
          parentNativeSessionId: b.parentNativeSessionId,
          bindingRef: reference(source, b),
          revoked: AbortSignal.any([
            input.signal,
            closed.signal,
            authority!,
            signal,
          ]),
        };
      });
    },
    /** A successful EOF releases authority without revoking its completed body.
     * Pending work is still aborted and actually joined; new work is refused. */
    close() {
      return (closing ??= (async () => {
        accepting = false;
        if (operations.size) closed.abort();
        await Promise.allSettled([...operations]);
      })());
    },
  };
}
