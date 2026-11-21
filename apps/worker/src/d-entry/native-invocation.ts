import { z } from 'zod';
import { TYPERT_REMOTE } from '@deepseek-ai/dsh-api-session-controller/remote';
import {
  parseRemoteStreamClientMessage,
  type RemoteStreamClientMessage,
} from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import { DataAccessError } from '@allrice/database';

type Resource = Readonly<{
  nativeSessionId: string;
  rootNativeSessionId: string;
  parentNativeSessionId: string | null;
  bindingRef: string;
}>;
type Authorize = (
  nativeSessionId: string,
  effect: 'read' | 'write',
  signal: AbortSignal,
) => Promise<Resource>;

// Source-owned semantics, not a method-name heuristic. rc.2 SessionController
// index.ts:462–574: prompt/queue/cancel/rename/selectModel mutate; attachment,
// page/follow/projections are reads. Unscoped/global/plugin endpoints have no
// proven thread resource here and remain unavailable, including $events/result.
const effects = {
  'session/attachment': 'read',
  'session/page': 'read',
  'session/follow': 'read',
  'session/projections': 'read',
  'skills/list': 'read',
  'session/prompt': 'write',
  'session/updateQueue': 'write',
  'session/cancel': 'write',
  'session/rename': 'write',
  'session/selectModel': 'write',
} as const;
type Endpoint = keyof typeof effects;
const payloadSchema = z
  .object({ args: z.record(z.string(), z.unknown()) })
  .strict();
const sessionSchema = z.object({ sessionId: z.string().min(1) });
const addressSchema = z.object({
  address: z.discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('session'), sessionId: z.string().min(1) })
      .strict(),
    z
      .object({
        kind: z.literal('subagent'),
        parentSessionId: z.string().min(1),
        childSessionId: z.string().min(1),
        mode: z.enum(['one-shot', 'continuable', 'unknown']),
      })
      .strict(),
  ]),
});
const deny = (): never => {
  throw new DataAccessError('authorization_denied');
};

/** Pure generated validation only. This performs no native I/O or resource
 * authorization; parsed input must not be dispatched before the guard below. */
export function parseDEntryNativeInvocation(
  endpoint: string,
  payload: unknown,
  carrier: 'http' | 'mux',
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!Object.hasOwn(effects, endpoint)) return deny();
  const key = endpoint as Endpoint;
  const descriptor = TYPERT_REMOTE.methods[key];
  if (
    (descriptor.mode === 'stream') !== (carrier === 'mux') ||
    descriptor.uplink
  )
    return deny();
  const envelope = payloadSchema.parse(payload);
  // Reuse the real generated codec, including nested unknown-field rejection.
  const args = descriptor.input({ strict: true }).create().parse(envelope.args);
  const request = z.object({ request: z.unknown() }).parse(args).request;
  const address =
    key === 'session/page' || key === 'session/follow'
      ? addressSchema.parse(request).address
      : null;
  const nativeSessionId = address
    ? address.kind === 'session'
      ? address.sessionId
      : address.childSessionId
    : sessionSchema.parse(request).sessionId;
  return {
    endpoint: key,
    effect: effects[key],
    payload: { args },
    nativeSessionId,
    parentNativeSessionId:
      address?.kind === 'subagent' ? address.parentSessionId : undefined,
  };
}

/** Returns forwardable bytes only after current resource authorization. */
export async function authorizeDEntryNativeInvocation(
  authorize: Authorize,
  endpoint: string,
  payload: unknown,
  carrier: 'http' | 'mux',
  signal: AbortSignal,
) {
  const parsed = parseDEntryNativeInvocation(
    endpoint,
    payload,
    carrier,
    signal,
  );
  const resource = await authorize(
    parsed.nativeSessionId,
    parsed.effect,
    signal,
  );
  signal.throwIfAborted();
  if (
    resource.nativeSessionId !== parsed.nativeSessionId ||
    (parsed.effect === 'write' &&
      (resource.nativeSessionId !== resource.rootNativeSessionId ||
        resource.parentNativeSessionId !== null)) ||
    (parsed.parentNativeSessionId !== undefined &&
      resource.parentNativeSessionId !== parsed.parentNativeSessionId)
  )
    return deny();
  return { ...parsed, resource };
}

/** Connection-local stream correlation only. It is not owner/lease authority.
 * Native cancel/end cannot introduce a new resource or send child user input. */
export function createDEntryMuxGate(authorize: Authorize) {
  const streams = new Map<
    string,
    Awaited<ReturnType<typeof authorizeDEntryNativeInvocation>>
  >();
  const admitting = new Set<string>();
  async function current(
    invocation: Awaited<ReturnType<typeof authorizeDEntryNativeInvocation>>,
    signal: AbortSignal,
  ) {
    const next = await authorize(
      invocation.resource.nativeSessionId,
      'read',
      signal,
    );
    const old = invocation.resource;
    if (
      next.nativeSessionId !== old.nativeSessionId ||
      next.rootNativeSessionId !== old.rootNativeSessionId ||
      next.parentNativeSessionId !== old.parentNativeSessionId ||
      next.bindingRef !== old.bindingRef
    )
      return deny();
    signal.throwIfAborted();
  }
  return {
    async accept(
      text: string,
      signal: AbortSignal,
    ): Promise<RemoteStreamClientMessage> {
      signal.throwIfAborted();
      const frame = parseRemoteStreamClientMessage(text);
      if (frame.type === 'open') {
        if (streams.has(frame.streamId) || admitting.has(frame.streamId))
          return deny();
        admitting.add(frame.streamId);
        try {
          const invocation = await authorizeDEntryNativeInvocation(
            authorize,
            frame.endpoint,
            frame.payload,
            'mux',
            signal,
          );
          signal.throwIfAborted();
          streams.set(frame.streamId, invocation);
          return {
            ...frame,
            endpoint: invocation.endpoint,
            payload: invocation.payload,
          };
        } finally {
          admitting.delete(frame.streamId);
        }
      }
      const invocation = streams.get(frame.streamId);
      if (!invocation || frame.type === 'item') return deny();
      // Even an idle stream must stop on real revocation; this check is also
      // used by the carrier before forwarding each server frame.
      await current(invocation, signal);
      return frame;
    },
    async authorizeFrame(streamId: string, signal: AbortSignal) {
      const invocation = streams.get(streamId);
      if (!invocation) return deny();
      await current(invocation, signal);
    },
    ended(streamId: string) {
      streams.delete(streamId);
    },
  };
}
