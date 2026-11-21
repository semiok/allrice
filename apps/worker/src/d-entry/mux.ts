import { randomUUID } from 'node:crypto';
import { on } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseRemoteStreamServerMessage } from '@deepseek-ai/dsh-api-gateway/stream-protocol';
import {
  DEntryNativeOwnerRequestSchema,
  sameDEntryIdentity,
} from '@allrice/contracts';
import {
  DataAccessError,
  runDEntryAdmittedActivity,
  type DEntryOwnedActivity,
} from '@allrice/database';
import {
  currentDEntryNativeOwner,
  DEntryNativeUnavailable,
  resolveDEntryNativeResource,
  sameDEntryVmBinding,
} from './native-owner.js';
import {
  dEntryHttpDefaults,
  dEntryBearer,
  currentDEntryRequest,
  dEntryHttpProblem,
  type DEntryHttpDependencies,
} from './http.js';
import { createDEntryMuxGate } from './native-invocation.js';
import { observeDEntryFinish, ownDEntryCatalog } from './native-data.js';

/** Authenticated Mux endpoint on the EXISTING Worker listener. Native auth and
 * the fixed physical target remain inside the injected per-request owner. */
export function createDEntryMuxHandler(
  deps: DEntryHttpDependencies = dEntryHttpDefaults,
  serviceSignal?: AbortSignal,
) {
  const wss = new WebSocketServer({ noServer: true });
  const pending = new Set<Promise<void>>();
  const aborters = new Set<AbortController>();
  const cleanupErrors: unknown[] = [];
  let stopping = false;
  let closing: Promise<void> | undefined;
  const matches = (request: IncomingMessage) =>
    request.url?.split('?')[0] === '/internal/d-entry/native-mux';
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const operation = (async () => {
      const abort = new AbortController();
      const browserClosed = new Promise<void>((resolve) =>
        socket.once('close', resolve),
      );
      aborters.add(abort);
      const signal = AbortSignal.any([
        abort.signal,
        ...(serviceSignal ? [serviceSignal] : []),
      ]);
      const disconnected = () => abort.abort();
      const socketError = (error: Error) => abort.abort(error);
      socket.once('close', disconnected);
      socket.on('error', socketError);
      let peer: WebSocket | undefined;
      let authority:
        Awaited<ReturnType<DEntryHttpDependencies['watch']>> | undefined;
      const revoke = () => abort.abort(authority?.revoked.reason);
      let failed = false;
      let failure: unknown;
      try {
        if (stopping) throw new DEntryNativeUnavailable();
        if (
          !matches(request) ||
          request.method !== 'GET' ||
          request.headers.origin
        )
          throw new DataAccessError('not_found');
        const url = new URL(request.url!, 'http://worker.invalid');
        const allowed = [
          'organizationId',
          'workspaceId',
          'employeeInstanceId',
          'threadId',
        ];
        if (
          [...url.searchParams.keys()].some(
            (key) =>
              !allowed.includes(key) ||
              url.searchParams.getAll(key).length !== 1,
          )
        )
          throw new SyntaxError('Invalid entry selectors');
        const fields = Object.fromEntries(url.searchParams);
        const { organizationId, ...selection } = fields;
        const input = DEntryNativeOwnerRequestSchema.parse({
          organizationId,
          selection,
        });
        if (!input.selection.threadId)
          throw new DataAccessError('authorization_denied');
        const token = dEntryBearer(request);
        const auth = await currentDEntryRequest(deps, token, input, signal);
        authority = await deps.watch(
          auth.context,
          input.selection,
          auth.identity,
          signal,
        );
        authority.revoked.addEventListener('abort', revoke, { once: true });
        if (authority.revoked.aborted) revoke();
        const current = await currentDEntryNativeOwner(
          deps.owners,
          auth.context,
          auth.identity,
          signal,
        );
        const data = deps.data();
        if (!data || !current.owner.controlReady())
          throw new DEntryNativeUnavailable();
        const assertCurrent = async (active: AbortSignal) => {
          const next = await currentDEntryRequest(deps, token, input, active);
          if (!sameDEntryIdentity(auth.identity, next.identity))
            throw new DataAccessError('authorization_denied');
          await current.owner.assertCurrent(next.context, active);
          if (current.owner.bindingRef !== current.view.bindingRef)
            throw new DataAccessError('authorization_denied');
          if (!current.owner.controlReady())
            throw new DEntryNativeUnavailable();
          active.throwIfAborted();
        };
        // Establish the real business root before any native connection opens.
        const pin = await deps.root(auth.context, input.selection);
        if (pin.vmId !== current.view.receipt.binding.vmId)
          throw new DataAccessError('authorization_denied');
        const operationId = randomUUID();
        const owner = await data.resolveAdmissionOwner({
          ...auth,
          owner: current.owner,
          operationId,
          signal: current.signal,
        });
        if (
          owner.operationId !== operationId ||
          owner.context.sessionId !== auth.context.sessionId ||
          owner.context.workspaceId !== auth.context.workspaceId ||
          !sameDEntryVmBinding(owner.binding, current.view.receipt.binding)
        )
          throw new DataAccessError('authorization_denied');
        await runDEntryAdmittedActivity(
          {
            ports: observeDEntryFinish(data.admission, (error) =>
              cleanupErrors.push(error),
            ),
            signal: current.signal,
            owner: {
              ...owner,
              async assertCurrent(active) {
                await assertCurrent(active);
                const next = await deps.root(auth.context, input.selection);
                if (
                  next.rootNativeSessionId !== pin.rootNativeSessionId ||
                  next.rootOriginDigest !== pin.rootOriginDigest ||
                  next.rootBindingRef !== pin.rootBindingRef ||
                  next.vmId !== pin.vmId ||
                  !sameDEntryIdentity(next.identity, auth.identity)
                )
                  throw new DataAccessError('authorization_denied');
                await owner.assertCurrent(active);
              },
            },
          },
          (active) => {
            // All catalog reads are children of this admitted request scope.
            const catalog = ownDEntryCatalog(current.owner, active);
            const authorize = async (
              nativeSessionId: string,
              effect: 'read' | 'write',
              active: AbortSignal,
            ) => {
              await assertCurrent(active);
              const resource = await resolveDEntryNativeResource({
                ...auth,
                owner: catalog.owner,
                nativeSessionId,
                signal: active,
                root: deps.root,
              });
              if (
                resource.rootNativeSessionId !== pin.rootNativeSessionId ||
                (effect === 'write' &&
                  (resource.nativeSessionId !== pin.rootNativeSessionId ||
                    resource.parentNativeSessionId !== null))
              )
                throw new DataAccessError('authorization_denied');
              return resource;
            };
            const mux = createDEntryMuxGate(authorize);
            // Acquire the trusted handle first; unknown acquisition stays rejected.
            let native: DEntryOwnedActivity<void>;
            let messages: ReturnType<typeof on> | undefined;
            let nativeClosing: Promise<void> | undefined;
            let task: Promise<void> | undefined;
            const closeNative = () =>
              (nativeClosing ??= Promise.resolve()
                .then(() => native.close())
                .catch((error) => {
                  cleanupErrors.push(error);
                  throw error;
                }));
            try {
              native = data.acquireMux(
                {
                  owner: current.owner,
                  async serve(channel, transferSignal) {
                    if (!peer || !messages) throw new DEntryNativeUnavailable();
                    const browser = peer;
                    const transfer = new AbortController();
                    const transferRoot = AbortSignal.any([
                      transferSignal,
                      transfer.signal,
                    ]);
                    const uplink = async () => {
                      for await (const [message, binary] of messages!) {
                        transferRoot.throwIfAborted();
                        if (binary)
                          throw new DataAccessError('authorization_denied');
                        const frame = await mux.accept(
                          String(message),
                          transferRoot,
                        );
                        transferRoot.throwIfAborted();
                        if (frame) await channel.send(JSON.stringify(frame));
                      }
                    };
                    const downlink = async () => {
                      for await (const text of channel.frames) {
                        transferRoot.throwIfAborted();
                        const frame = parseRemoteStreamServerMessage(text);
                        await mux.authorizeFrame(frame.streamId, transferRoot);
                        if (frame.type !== 'item') mux.ended(frame.streamId);
                        await new Promise<void>((resolve, reject) =>
                          browser.send(JSON.stringify(frame), (error) =>
                            error ? reject(error) : resolve(),
                          ),
                        );
                      }
                    };
                    // Actual close is still the native handle's responsibility. This
                    // abort only releases the browser event iterator on either end.
                    const stop = () => {
                      transfer.abort();
                      // Stop the browser iterator independently; native.close owns
                      // real transport cancellation and the actual child join.
                      peer?.terminate();
                      void closeNative().catch(() => {});
                    };
                    const results = await Promise.allSettled([
                      uplink().finally(stop),
                      downlink().finally(stop),
                    ]);
                    const errors = results.flatMap((result) =>
                      result.status === 'rejected' ? [result.reason] : [],
                    );
                    if (errors.length)
                      throw new AggregateError(
                        errors,
                        'Native Mux transfer stopped',
                      );
                  },
                },
                active,
              );
            } catch (error) {
              void catalog.close().catch(() => {});
              cleanupErrors.push(error);
              throw error;
            }
            return {
              run(running: AbortSignal) {
                return (task = (async () => {
                  running.throwIfAborted();
                  peer = await new Promise<WebSocket>((resolve, reject) => {
                    let done = false;
                    const cleanup = () => {
                      socket.off('close', fail);
                      socket.off('error', fail);
                      running.removeEventListener('abort', fail);
                    };
                    const fail = () => {
                      if (done) return;
                      done = true;
                      cleanup();
                      reject(running.reason ?? new DEntryNativeUnavailable());
                    };
                    socket.once('close', fail);
                    socket.once('error', fail);
                    running.addEventListener('abort', fail, { once: true });
                    if (running.aborted) {
                      fail();
                      return;
                    }
                    try {
                      wss.handleUpgrade(request, socket, head, (ws) => {
                        if (done) {
                          ws.terminate();
                          return;
                        }
                        done = true;
                        cleanup();
                        resolve(ws);
                      });
                    } catch (error) {
                      done = true;
                      cleanup();
                      reject(error);
                    }
                  });
                  peer.once('close', disconnected);
                  peer.on('error', socketError);
                  messages = on(peer, 'message', {
                    signal: running,
                    close: ['close'],
                    highWaterMark: 1,
                    lowWaterMark: 1,
                  });
                  await native.run(running);
                })());
              },
              async close() {
                peer?.terminate();
                socket.destroy();
                const results = await Promise.allSettled([
                  closeNative(),
                  catalog.close(),
                  browserClosed,
                  messages?.return?.(),
                  task?.catch(() => {}), // Business rejection is preserved by ownedOutcome; this only joins it.
                ]);
                const failures = results.flatMap((result) =>
                  result.status === 'rejected' ? [result.reason] : [],
                );
                if (failures.length) {
                  const error = new AggregateError(
                    failures,
                    'Native Mux close is unknown',
                    { cause: failures[0] },
                  );
                  cleanupErrors.push(error);
                  throw error;
                }
              },
            };
          },
        );
      } catch (error) {
        if (!peer && !socket.destroyed && !socket.writableEnded)
          await Promise.race([
            new Promise<void>((resolve) =>
              socket.end(
                `HTTP/1.1 ${dEntryHttpProblem(error).status} Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
                resolve,
              ),
            ),
            browserClosed,
          ]);
        if (peer) peer.terminate();
        failed = true;
        failure = error;
      } finally {
        authority?.revoked.removeEventListener('abort', revoke);
        try {
          await authority?.close();
        } catch (error) {
          cleanupErrors.push(error);
          failure = failed
            ? new AggregateError(
                [failure, error],
                'Mux authority close unknown',
                { cause: failure },
              )
            : error;
          failed = true;
        } finally {
          socket.destroy();
          await browserClosed;
          socket.off('close', disconnected);
          socket.off('error', socketError);
          aborters.delete(abort);
        }
      }
      if (failed) throw failure;
    })();
    pending.add(operation);
    // The request caller observes rejection; shutdown joins active operations.
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  return {
    matches,
    upgrade,
    close() {
      if (closing) return closing;
      stopping = true;
      for (const abort of aborters) abort.abort();
      closing = (async () => {
        await Promise.allSettled([...pending]);
        await new Promise<void>((resolve, reject) =>
          wss.close((error) => (error ? reject(error) : resolve())),
        );
        if (cleanupErrors.length)
          throw new AggregateError(
            cleanupErrors,
            'D entry Mux cleanup is unknown',
          );
      })();
      return closing;
    },
  };
}
