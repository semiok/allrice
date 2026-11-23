import type { DEntryIdentity, RequestContext } from '@allrice/contracts';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {
  SessionCreateRequest,
  SessionCreateValue,
} from '@deepseek-ai/dsh-api-session-controller/types';
import type {
  DEntryAdmissionOwner,
  DEntryAdmissionPorts,
  DEntryOwnedActivity,
} from '@allrice/database';
import type { ResolvedDEntryNativeOwner } from './native-owner.js';
import type { parseDEntryNativeInvocation } from './native-invocation.js';

export type DEntryNativeInvocation = Awaited<
  ReturnType<typeof parseDEntryNativeInvocation>
>;
export type DEntryNativeMuxChannel = Readonly<{
  frames: AsyncIterable<string>;
  send(frame: string): Promise<void>;
}>;

/** 271-owned request adapter requirements, NOT an implemented 273 transport.
 * A trusted composition must provide the real complete envelope resolver and
 * owned handles covering partial init, all children and actual transport join.
 * acquire is synchronous: failure before a handle exists stays unknown. run
 * starts I/O; close actively cancels then joins it. No long-lived job.close. */
export interface DEntryNativeDataPort {
  admission: DEntryAdmissionPorts;
  resolveAdmissionOwner(input: {
    context: RequestContext;
    identity: DEntryIdentity;
    owner: ResolvedDEntryNativeOwner;
    operationId: string;
    signal: AbortSignal;
  }): Promise<DEntryAdmissionOwner>;
  acquireRpc(
    input: {
      owner: ResolvedDEntryNativeOwner;
      // Parsed generated input only. The adapter calls run ONLY after the
      // admitted catalog/root guard. Construction must not dispatch the RPC.
      invocation: DEntryNativeInvocation;
      consume(response: Response, signal: AbortSignal): Promise<void>;
    },
    signal: AbortSignal,
  ): DEntryOwnedActivity<void>;
  acquireMux(
    input: {
      owner: ResolvedDEntryNativeOwner;
      serve(
        channel: DEntryNativeMuxChannel,
        signal: AbortSignal,
      ): Promise<void>;
    },
    signal: AbortSignal,
  ): DEntryOwnedActivity<void>;
  /** Host-only generated session/create, never a browser-provided native id,
   * path, preset or generic RPC. Actual profile authentication and partial-init
   * cancellation/join remain owned by this same real transport handle. Like
   * acquireRpc, constructing the handle must not start I/O; only run may. */
  acquireRoot(
    input: {
      owner: ResolvedDEntryNativeOwner;
      request: Readonly<SessionCreateRequest>;
    },
    signal: AbortSignal,
  ): DEntryOwnedActivity<RemoteResult<SessionCreateValue>>;
}

let installed: DEntryNativeDataPort | undefined;
export function installDEntryNativeDataPort(port: DEntryNativeDataPort) {
  if (installed) throw Error('D_ENTRY_DATA_PORT_ALREADY_INSTALLED');
  installed = port;
  return () => {
    if (installed === port) installed = undefined;
  };
}
export function currentDEntryNativeDataPort() {
  return installed;
}

/** Own the actual unary catalog children INSIDE one admitted request. A
 * fulfilled readSessions Promise is the owner's completed read operation;
 * raw rejection lacks a joined-close fact and remains unknown on close. */
export function ownDEntryCatalog(
  owner: ResolvedDEntryNativeOwner,
  signal: AbortSignal,
) {
  const abort = new AbortController();
  const reads = new Set<
    ReturnType<ResolvedDEntryNativeOwner['readSessions']>
  >();
  const failures: unknown[] = [];
  let closing: Promise<void> | undefined;
  const scoped: ResolvedDEntryNativeOwner = {
    receipt: owner.receipt,
    endpoint: owner.endpoint,
    bindingRef: owner.bindingRef,
    revoked: owner.revoked,
    controlReady: owner.controlReady.bind(owner),
    assertCurrent: owner.assertCurrent.bind(owner),
    readSessions(caller) {
      const current = AbortSignal.any([
        signal,
        caller,
        abort.signal,
        owner.revoked,
      ]);
      current.throwIfAborted();
      let read: ReturnType<ResolvedDEntryNativeOwner['readSessions']>;
      try {
        read = Promise.resolve(owner.readSessions(current));
      } catch (error) {
        read = Promise.reject(error);
      }
      reads.add(read);
      void read.then(
        () => reads.delete(read),
        (error) => {
          reads.delete(read);
          failures.push(error);
        },
      );
      return read;
    },
  };
  return {
    owner: scoped,
    close() {
      if (closing) return closing;
      abort.abort();
      closing = (async () => {
        await Promise.allSettled([...reads]);
        if (failures.length)
          throw new AggregateError(failures, 'Catalog read join is unknown', {
            cause: failures[0],
          });
      })();
      return closing;
    },
  };
}

/** Observe failed release ACKs without changing the real boundary semantics.
 * Business rejection after known join is separate from unknown cleanup. */
export function observeDEntryFinish(
  ports: DEntryAdmissionPorts,
  unknown: (error: unknown) => void,
): DEntryAdmissionPorts {
  const boundary = ports.boundary;
  return {
    ...ports,
    boundary: {
      admit: boundary.admit.bind(boundary),
      queued: boundary.queued.bind(boundary),
      activate: boundary.activate.bind(boundary),
      waitUntilReady: boundary.waitUntilReady.bind(boundary),
      async finish(permit) {
        try {
          await boundary.finish(permit);
        } catch (error) {
          unknown(error);
          throw error;
        }
      },
    },
  };
}
