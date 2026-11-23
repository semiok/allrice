import { AsyncLocalStorage } from 'node:async_hooks';
import {
  DEntryIdentitySchema,
  RequestContextSchema,
  sameDEntryIdentity,
  type DEntryIdentity,
  type RequestContext,
} from '@allrice/contracts';
import {
  readContentPrincipal,
  requireDEntryNativeIdentity,
} from '@allrice/database';
import {
  PersonVmError,
  type PersonVmAction,
  type PersonVmAuthority,
} from '@allrice/person-vm';

type Operation = {
  context: RequestContext;
  expected: DEntryIdentity;
  signal: AbortSignal;
  active: boolean;
  pending: Set<Promise<unknown>>;
};
function denied(): never {
  throw new PersonVmError('AUTHORIZATION_DENIED');
}
function user(context: RequestContext) {
  const parsed = RequestContextSchema.parse(context);
  if (parsed.actor.type !== 'user') denied();
  return parsed;
}

/** Current database reads only. The private operation carries a selector and
 * expected identity, never a reusable permit or a writer transaction fence. */
export function createProductionPersonVmAuthority(lifetime?: AbortSignal) {
  const operations = new AsyncLocalStorage<Operation>();
  const stopped = new AbortController();
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  const active = (signal: AbortSignal, operation?: Operation) =>
    AbortSignal.any([
      stopped.signal,
      signal,
      ...(lifetime ? [lifetime] : []),
      ...(operation ? [operation.signal] : []),
    ]);
  function own<T>(work: () => Promise<T>, operation?: Operation) {
    const task = Promise.resolve().then(work);
    pending.add(task);
    operation?.pending.add(task);
    const settled = () => {
      pending.delete(task);
      operation?.pending.delete(task);
    };
    void task.then(settled, settled);
    return task;
  }
  function guard(operation: Operation, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!operation.active) denied();
  }
  async function current(operation: Operation, signal: AbortSignal) {
    guard(operation, signal);
    const { expected, context } = operation;
    const identity = await requireDEntryNativeIdentity(context, {
      workspaceId: expected.workspaceId,
      employeeInstanceId: expected.employeeInstanceId,
      ...(expected.threadId ? { threadId: expected.threadId } : {}),
    });
    guard(operation, signal);
    if (!sameDEntryIdentity(identity, expected)) denied();
    // The original gate awaits rollout policy. Re-read the original current
    // principal afterward; old RC memberships cannot survive that async gap.
    const principal = await readContentPrincipal({
      ...context,
      workspaceId: expected.workspaceId,
    });
    guard(operation, signal);
    if (
      !principal ||
      !principal.writable ||
      principal.userId !== expected.personId ||
      principal.organizationId !== expected.organizationId
    )
      denied();
    return {
      personId: principal.userId,
      organizationId: principal.organizationId,
    };
  }
  const authority: PersonVmAuthority = Object.freeze({
    authorize(
      context: RequestContext,
      action: PersonVmAction,
      signal: AbortSignal,
    ) {
      const operation = operations.getStore();
      return own(async () => {
        const stop = active(signal, operation);
        stop.throwIfAborted();
        if (operation) guard(operation, stop);
        const scope = user(context);
        if (action === 'read') {
          const principal = await readContentPrincipal(scope);
          stop.throwIfAborted();
          if (operation) guard(operation, stop);
          if (
            !principal ||
            principal.userId !== scope.actor.id ||
            principal.organizationId !== scope.organizationId
          )
            denied();
          return {
            personId: principal.userId,
            organizationId: principal.organizationId,
          };
        }
        // No new public stop/delete permission. Existing internal owner cleanup
        // does not obtain authority by pretending to be a read/start request.
        if (action !== 'create' && action !== 'start') denied();
        if (
          !operation ||
          !operation.active ||
          operation.context.sessionId !== scope.sessionId ||
          operation.context.actor.id !== scope.actor.id ||
          operation.context.organizationId !== scope.organizationId ||
          operation.context.workspaceId !== scope.workspaceId
        )
          denied();
        return current(operation, stop);
      }, operation);
    },
  });
  return Object.freeze({
    authority,
    withCurrentSelection<T>(
      context: RequestContext,
      expected: DEntryIdentity,
      signal: AbortSignal,
      work: () => Promise<T>,
    ): Promise<T> {
      return own(async () => {
        const scope = user(context);
        const identity = DEntryIdentitySchema.parse(expected);
        if (
          identity.personId !== scope.actor.id ||
          identity.organizationId !== scope.organizationId ||
          (scope.workspaceId !== null &&
            scope.workspaceId !== identity.workspaceId)
        )
          denied();
        const operation: Operation = {
          context: scope,
          expected: Object.freeze(identity),
          signal: active(signal),
          active: true,
          pending: new Set(),
        };
        return operations.run(operation, async () => {
          let result: T;
          try {
            await current(operation, operation.signal);
            result = await work();
            await current(operation, operation.signal);
          } finally {
            operation.active = false;
            // Detached descendants keep the closed scope and cannot authorize.
            // Already started SQL still joins before the operation leaves.
            await Promise.allSettled([...operation.pending]);
          }
          operation.signal.throwIfAborted();
          return result;
        });
      });
    },
    close() {
      if (closing) return closing;
      stopped.abort(new PersonVmError('RUNTIME_NOT_READY'));
      closing = Promise.allSettled([...pending]).then(() => {});
      return closing;
    },
  });
}
