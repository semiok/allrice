import { z } from 'zod';
import {
  DEntryNativeResourceFactsSchema,
  UuidSchema,
  type DEntryIdentity,
  type RequestContext,
  sameDEntryIdentity,
} from '@allrice/contracts';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionListValue } from '@deepseek-ai/dsh-api-session-controller/types';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import { DataAccessError, getDEntryNativeRootPin } from '@allrice/database';

const endpointSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeInstanceId: UuidSchema,
    employeeRevision: z.number().int().positive(),
    employeeVersionId: UuidSchema,
    hostPort: z.number().int().min(1).max(65535),
    guestPort: z.number().int().min(1).max(65535),
  })
  .strict();
// Consumed discovery projection from frozen v1, not a second provider receipt
// producer. 273 owns its original receipt export/issuance and actual transports.
export const dEntryOwnerViewSchema = z
  .object({
    receipt: z
      .object({
        binding: z
          .object({
            vmId: z.string().min(1),
            instanceId: z.string().min(1),
            organizationId: UuidSchema,
            personId: UuidSchema,
            leaseEpoch: z.number().int().positive(),
          })
          .strict(),
        rosterDigest: z.string().min(1),
        endpoints: z.array(endpointSchema),
      })
      .strict(),
    endpoint: endpointSchema,
    bindingRef: z.string().min(1),
    controlReady: z.boolean(),
  })
  .strict();
type OwnerView = z.infer<typeof dEntryOwnerViewSchema>;
type ConsumedReceipt = Readonly<{
  binding: Readonly<OwnerView['receipt']['binding']>;
  rosterDigest: string;
  endpoints: readonly Readonly<OwnerView['endpoint']>[];
}>;
export type ResolvedDEntryNativeOwner = Readonly<{
  receipt: ConsumedReceipt;
  endpoint: Readonly<OwnerView['endpoint']>;
  bindingRef: string;
  revoked: AbortSignal;
  controlReady(): boolean;
  assertCurrent(context: RequestContext, signal: AbortSignal): Promise<void>;
  readSessions(signal: AbortSignal): Promise<RemoteResult<SessionListValue>>;
}>;
export interface DEntryNativeOwnerPort {
  resolve(
    context: RequestContext,
    identity: DEntryIdentity,
    signal: AbortSignal,
  ): Promise<ResolvedDEntryNativeOwner>;
}
export class DEntryNativeUnavailable extends Error {
  constructor() {
    super('D entry native owner is not bound');
  }
}

// Composition registration only. No map of people/leases/authority, no fallback
// provider, no new listener, and never populated by a browser request.
let installed: DEntryNativeOwnerPort | undefined;
export function installDEntryNativeOwnerPort(port: DEntryNativeOwnerPort) {
  if (installed) throw new DEntryNativeUnavailable();
  installed = port;
  return () => {
    if (installed === port) installed = undefined;
  };
}
export const dEntryNativeOwnerPort: DEntryNativeOwnerPort = {
  resolve(context, identity, signal) {
    signal.throwIfAborted();
    if (!installed) throw new DEntryNativeUnavailable();
    return installed.resolve(context, identity, signal);
  },
};
const deny = (): never => {
  throw new DataAccessError('authorization_denied');
};
export function sameDEntryVmBinding(
  a: z.infer<typeof dEntryOwnerViewSchema>['receipt']['binding'],
  b: z.infer<typeof dEntryOwnerViewSchema>['receipt']['binding'],
) {
  return (
    ['organizationId', 'personId', 'vmId', 'instanceId', 'leaseEpoch'] as const
  ).every((key) => a[key] === b[key]);
}

export async function currentDEntryNativeOwner(
  port: DEntryNativeOwnerPort,
  context: RequestContext,
  identity: DEntryIdentity,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const owner = await port.resolve(context, identity, signal);
  const current = AbortSignal.any([signal, owner.revoked]);
  current.throwIfAborted();
  await owner.assertCurrent(context, current);
  current.throwIfAborted();
  const view = dEntryOwnerViewSchema.parse({
    receipt: owner.receipt,
    endpoint: owner.endpoint,
    bindingRef: owner.bindingRef,
    controlReady: owner.controlReady(),
  });
  const { binding } = view.receipt;
  const selected = view.receipt.endpoints.filter(
    (endpoint) =>
      endpoint.workspaceId === identity.workspaceId &&
      endpoint.employeeInstanceId === identity.employeeInstanceId &&
      endpoint.employeeRevision === identity.employeeRevision &&
      endpoint.employeeVersionId === identity.employeeVersionId,
  );
  if (
    context.actor.type !== 'user' ||
    context.actor.id !== identity.personId ||
    identity.organizationId !== context.organizationId ||
    binding.organizationId !== identity.organizationId ||
    binding.personId !== identity.personId ||
    selected.length !== 1 ||
    JSON.stringify(selected[0]) !== JSON.stringify(view.endpoint)
  )
    return deny();
  return { owner, view, signal: current };
}

/** Combines two independent owners: SaaS immutable business pin and native
 * ancestry. No browser root, current list ordering or guessed id grants access. */
export async function resolveDEntryNativeResource(input: {
  context: RequestContext;
  identity: DEntryIdentity;
  nativeSessionId: string;
  owner: ResolvedDEntryNativeOwner;
  signal: AbortSignal;
  root?: typeof getDEntryNativeRootPin;
}) {
  const { context, identity, owner, nativeSessionId } = input;
  if (!identity.threadId) return deny();
  const signal = AbortSignal.any([input.signal, owner.revoked]);
  signal.throwIfAborted();
  const selection = {
    workspaceId: identity.workspaceId,
    employeeInstanceId: identity.employeeInstanceId,
    threadId: identity.threadId,
  };
  const pin = await (input.root ?? getDEntryNativeRootPin)(context, selection);
  if (!sameDEntryIdentity(pin.identity, identity)) return deny();
  await owner.assertCurrent(context, signal);
  signal.throwIfAborted();
  const result = await owner.readSessions(signal);
  signal.throwIfAborted();
  if (!result.ok)
    throw new RemoteError(
      result.error.code,
      result.error.message,
      result.error.details,
    );
  const catalog = TYPERT_REMOTE.methods['session/list'].result
    .create()
    .parse(result.value);
  const entries = new Map(
    catalog.items.map((entry) => [String(entry.sessionId), entry]),
  );
  if (entries.size !== catalog.items.length) return deny();
  const root = entries.get(pin.rootNativeSessionId);
  if (!root || root.parentSessionId || root.origin === 'subagent')
    return deny();
  let cursor = entries.get(nativeSessionId);
  if (!cursor) return deny();
  const parent = cursor.parentSessionId ?? null;
  const visited = new Set<string>();
  while (cursor.sessionId !== pin.rootNativeSessionId) {
    if (visited.has(cursor.sessionId) || !cursor.parentSessionId) return deny();
    visited.add(cursor.sessionId);
    const next = entries.get(cursor.parentSessionId);
    if (!next) return deny();
    cursor = next;
  }
  // Re-read the actual business pin after the native read so a replacement
  // cannot turn a stale catalog into current resource authority.
  const after = await (input.root ?? getDEntryNativeRootPin)(
    context,
    selection,
  );
  if (
    !sameDEntryIdentity(after.identity, identity) ||
    after.rootNativeSessionId !== pin.rootNativeSessionId ||
    after.rootOriginDigest !== pin.rootOriginDigest ||
    after.threadGeneration !== pin.threadGeneration
  )
    return deny();
  await owner.assertCurrent(context, signal);
  signal.throwIfAborted();
  return DEntryNativeResourceFactsSchema.parse({
    organizationId: identity.organizationId,
    personId: identity.personId,
    employeeInstanceId: identity.employeeInstanceId,
    threadId: identity.threadId,
    nativeSessionId,
    rootNativeSessionId: pin.rootNativeSessionId,
    parentNativeSessionId: parent,
    bindingRef: owner.bindingRef,
  });
}
