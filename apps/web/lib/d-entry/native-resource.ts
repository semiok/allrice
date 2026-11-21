import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import {
  DataAccessError,
  getSessionExecutionGeneration,
} from '@allrice/database';
import { resolveDEntryIdentity } from './identity';
import { resolveDEntryAdmission } from './admission';
import { readDEntryReleasePolicy } from './release-policy';

/** Host-verified catalog/descriptor facts. A browser's same-shaped JSON is not
 * an implementation of this port and cannot establish native root membership. */
export type DEntryNativeResource = Readonly<{
  organizationId: string;
  personId: string;
  employeeInstanceId: string;
  threadId: string;
  nativeSessionId: string;
  rootNativeSessionId: string;
  parentNativeSessionId: string | null;
  bindingRef: string;
  /** Current host permission/lease revocation. Must cancel real I/O even while
   * no stream item is arriving; it is never serialized to the browser. */
  revoked: AbortSignal;
}>;

export interface DEntryNativeResourcePort {
  /** Verify the session against the host-owned root pin and complete native
   * ancestry. A guest-edited descriptor must not promote a child to the root. */
  resolve(
    identity: DEntryIdentity,
    nativeSessionId: string,
    signal: AbortSignal,
  ): Promise<DEntryNativeResource>;
}

/** Trusted method metadata supplies the effect. HTTP method names and browser
 * flags never classify a native operation as read-only. This gate applies to
 * the 4.0 browser lane; native parent tools do not call it. */
export async function authorizeDEntryNativeResource(input: {
  context: RequestContext;
  identity: DEntryIdentity;
  nativeSessionId: string;
  effect: 'read' | 'write';
  resources: DEntryNativeResourcePort;
  signal: AbortSignal;
}) {
  input.signal.throwIfAborted();
  if (!input.identity.threadId)
    throw new DataAccessError('authorization_denied');
  const identity = await resolveDEntryIdentity(
    input.context,
    {
      workspaceId: input.identity.workspaceId,
      employeeInstanceId: input.identity.employeeInstanceId,
      threadId: input.identity.threadId,
    },
    input.effect === 'read' ? 'history' : 'execute',
  );
  if (
    !identity.threadId ||
    identity.personId !== input.identity.personId ||
    identity.organizationId !== input.identity.organizationId ||
    identity.employeeRevision !== input.identity.employeeRevision ||
    identity.employeeVersionId !== input.identity.employeeVersionId ||
    (await getSessionExecutionGeneration(
      input.context,
      identity.workspaceId,
      identity.threadId,
    )) !== '4.0'
  )
    throw new DataAccessError('authorization_denied');
  const resource = await input.resources.resolve(
    identity,
    input.nativeSessionId,
    input.signal,
  );
  if (
    resource.organizationId !== identity.organizationId ||
    resource.personId !== identity.personId ||
    resource.employeeInstanceId !== identity.employeeInstanceId ||
    resource.threadId !== identity.threadId ||
    resource.nativeSessionId !== input.nativeSessionId ||
    !resource.rootNativeSessionId ||
    !resource.bindingRef ||
    (resource.nativeSessionId === resource.rootNativeSessionId
      ? resource.parentNativeSessionId !== null
      : !resource.parentNativeSessionId || input.effect !== 'read')
  )
    throw new DataAccessError('authorization_denied');
  if (input.effect === 'write')
    await resolveDEntryAdmission(
      input.context,
      {
        workspaceId: identity.workspaceId,
        employeeInstanceId: identity.employeeInstanceId,
        threadId: identity.threadId,
      },
      await readDEntryReleasePolicy(input.context, input.signal),
    );
  input.signal.throwIfAborted();
  resource.revoked.throwIfAborted();
  return resource;
}

/** Re-admit each delivered resource/stream chunk. Revocation aborts the actual
 * reader and closes its iterator; it cannot retract bytes already returned. */
export async function* followDEntryNativeResource<T>(
  input: Omit<Parameters<typeof authorizeDEntryNativeResource>[0], 'effect'>,
  open: (
    resource: DEntryNativeResource,
    signal: AbortSignal,
  ) => AsyncIterable<T>,
): AsyncGenerator<T> {
  const abort = new AbortController();
  let iterator: AsyncIterator<T> | undefined;
  try {
    const resource = await authorizeDEntryNativeResource({
      ...input,
      effect: 'read',
    });
    const signal = AbortSignal.any([
      input.signal,
      abort.signal,
      resource.revoked,
    ]);
    signal.throwIfAborted();
    iterator = open(resource, signal)[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      signal.throwIfAborted();
      if (next.done) break;
      const current = await authorizeDEntryNativeResource({
        ...input,
        signal,
        effect: 'read',
      });
      if (
        current.bindingRef !== resource.bindingRef ||
        current.rootNativeSessionId !== resource.rootNativeSessionId ||
        current.parentNativeSessionId !== resource.parentNativeSessionId
      )
        throw new DataAccessError('authorization_denied');
      yield next.value;
    }
  } finally {
    abort.abort();
    await iterator?.return?.();
  }
}
