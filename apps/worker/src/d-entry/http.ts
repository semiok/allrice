import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import {
  DEntryNativeOwnerRequestSchema,
  DEntryNativeResourceRequestSchema,
  sameDEntryIdentity,
} from '@allrice/contracts';
import {
  authenticateSession,
  DataAccessError,
  requireDEntryNativeIdentity,
  getDEntryNativeRootPin,
  runDEntryAdmittedActivity,
  type DEntryOwnedActivity,
} from '@allrice/database';
import {
  currentDEntryNativeOwner,
  dEntryNativeOwnerPort,
  DEntryNativeUnavailable,
  resolveDEntryNativeResource,
  type DEntryNativeOwnerPort,
  sameDEntryVmBinding,
} from './native-owner.js';
import {
  authorizeDEntryNativeInvocation,
  parseDEntryNativeInvocation,
} from './native-invocation.js';
import {
  currentDEntryNativeDataPort,
  observeDEntryFinish,
  ownDEntryCatalog,
} from './native-data.js';

export const dEntryRpcRequestSchema = DEntryNativeResourceRequestSchema.omit({
  nativeSessionId: true,
}).extend({
  endpoint: z.string().min(1),
  payload: z.unknown(),
});
export type DEntryHttpDependencies = {
  authenticate: typeof authenticateSession;
  identity: typeof requireDEntryNativeIdentity;
  root: typeof getDEntryNativeRootPin;
  owners: DEntryNativeOwnerPort;
  data: typeof currentDEntryNativeDataPort;
};
export const dEntryHttpDefaults: DEntryHttpDependencies = {
  authenticate: authenticateSession,
  identity: requireDEntryNativeIdentity,
  root: getDEntryNativeRootPin,
  owners: dEntryNativeOwnerPort,
  data: currentDEntryNativeDataPort,
};
export function dEntryBearer(request: IncomingMessage) {
  const value = request.headers.authorization;
  // Same opaque session-token grammar as the existing diagnostics listener.
  if (!value || !/^Bearer [A-Za-z0-9_-]{16,4096}$/.test(value))
    throw new DataAccessError('authentication_required');
  return value.slice(7);
}

/** Authenticates the original session, never a RequestContext from JSON. */
export async function currentDEntryRequest(
  deps: DEntryHttpDependencies,
  token: string,
  input: z.infer<typeof DEntryNativeOwnerRequestSchema>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const context = await deps.authenticate(token, {
    organizationId: input.organizationId,
    workspaceId: input.selection.workspaceId,
  });
  if (!context) throw new DataAccessError('authentication_required');
  const identity = await deps.identity(context, input.selection);
  signal.throwIfAborted();
  return { context, identity };
}

export function dEntryHttpProblem(error: unknown) {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  if (code === 'authentication_required')
    return { status: 401, code: 'AUTHENTICATION_REQUIRED' as const };
  if (
    [
      'authorization_denied',
      'not_found',
      'tenant_context_invalid',
      'execution_generation_mismatch',
    ].includes(String(code))
  )
    return { status: 404, code: 'RESOURCE_NOT_FOUND' as const };
  if (error instanceof SyntaxError || error instanceof z.ZodError)
    return { status: 400, code: 'VALIDATION_FAILED' as const };
  return { status: 503, code: 'DEPENDENCY_UNAVAILABLE' as const };
}
export function sendDEntryHttpProblem(
  response: ServerResponse,
  error: unknown,
) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const problem = dEntryHttpProblem(error);
  response.writeHead(problem.status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(
    JSON.stringify({
      error: {
        code: problem.code,
        message: 'The selected entry is not available',
        requestId: randomUUID(),
        retryable: false,
      },
    }),
  );
}

export function createDEntryHttpHandler(
  deps = dEntryHttpDefaults,
  serviceSignal?: AbortSignal,
) {
  const lifetime = new AbortController();
  const pending = new Set<Promise<boolean>>();
  const cleanupErrors: unknown[] = [];
  let closing: Promise<void> | undefined;
  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
    stopping = false,
  ) => {
    const path = request.url;
    if (
      ![
        '/internal/d-entry/native-owner',
        '/internal/d-entry/native-resource',
        '/internal/d-entry/native-rpc',
      ].includes(path ?? '')
    )
      return false;
    const abort = new AbortController();
    const signal = AbortSignal.any([
      abort.signal,
      lifetime.signal,
      ...(serviceSignal ? [serviceSignal] : []),
    ]);
    const disconnect = () => {
      if (!response.writableEnded) abort.abort();
    };
    const responseError = (error: Error) => abort.abort(error);
    const cancelBody = () => {
      if (!request.complete) request.destroy();
    };
    response.once('close', disconnect);
    response.once('error', responseError);
    signal.addEventListener('abort', cancelBody, { once: true });
    let parsedInput = false;
    try {
      signal.throwIfAborted();
      if (request.method !== 'POST' || request.headers.origin)
        throw new DataAccessError('not_found');
      if (stopping) throw new DEntryNativeUnavailable();
      const token = dEntryBearer(request);
      // Authenticate before buffering a native RPC's potentially large body.
      // The context used for authorization is resolved AGAIN with the parsed
      // tenant/selection; this first result never establishes that scope.
      if (!(await deps.authenticate(token)))
        throw new DataAccessError('authentication_required');
      signal.throwIfAborted();
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        signal.throwIfAborted();
        size += chunk.length;
        // Reuse the existing narrow Worker identity-request body budget.
        if (path !== '/internal/d-entry/native-rpc' && size > 4096)
          throw new SyntaxError('Invalid entry request');
        chunks.push(Buffer.from(chunk));
      }
      const decoded: unknown = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      );
      const rpc =
        path === '/internal/d-entry/native-rpc'
          ? dEntryRpcRequestSchema.parse(decoded)
          : undefined;
      const resourceRequest =
        path === '/internal/d-entry/native-resource'
          ? DEntryNativeResourceRequestSchema.parse(decoded)
          : undefined;
      const input =
        rpc ?? resourceRequest ?? DEntryNativeOwnerRequestSchema.parse(decoded);
      const parsedRpc = rpc
        ? parseDEntryNativeInvocation(rpc.endpoint, rpc.payload, 'http', signal)
        : undefined;
      parsedInput = true;
      const auth = await currentDEntryRequest(deps, token, input, signal);
      const current = await currentDEntryNativeOwner(
        deps.owners,
        auth.context,
        auth.identity,
        signal,
      );
      const assertCurrent = async (active: AbortSignal) => {
        const next = await currentDEntryRequest(deps, token, input, active);
        if (!sameDEntryIdentity(auth.identity, next.identity))
          throw new DataAccessError('authorization_denied');
        await current.owner.assertCurrent(next.context, active);
        if (current.owner.bindingRef !== current.view.bindingRef)
          throw new DataAccessError('authorization_denied');
        active.throwIfAborted();
      };
      if (rpc || resourceRequest) {
        const data = deps.data();
        if (!data) throw new DEntryNativeUnavailable();
        const parsed = parsedRpc;
        const pin = await deps.root(auth.context, input.selection);
        const assertPinned = async (active: AbortSignal) => {
          await assertCurrent(active);
          const next = await deps.root(auth.context, input.selection);
          if (
            next.rootNativeSessionId !== pin.rootNativeSessionId ||
            next.rootOriginDigest !== pin.rootOriginDigest ||
            next.threadGeneration !== pin.threadGeneration ||
            !sameDEntryIdentity(next.identity, auth.identity)
          )
            throw new DataAccessError('authorization_denied');
          active.throwIfAborted();
        };
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
        let value: unknown;
        await runDEntryAdmittedActivity(
          {
            ports: observeDEntryFinish(data.admission, (error) =>
              cleanupErrors.push(error),
            ),
            signal: current.signal,
            owner: {
              ...owner,
              async assertCurrent(active) {
                await assertPinned(active);
                await owner.assertCurrent(active);
              },
            },
          },
          (active) => {
            const catalog = ownDEntryCatalog(current.owner, active);
            let activity: DEntryOwnedActivity<void> | undefined;
            if (parsed) {
              try {
                activity = data.acquireRpc(
                  {
                    owner: current.owner,
                    invocation: parsed,
                    async consume(upstream, reading) {
                      if (upstream.status >= 300 && upstream.status < 400)
                        throw new DEntryNativeUnavailable();
                      await assertPinned(reading);
                      // Only body/content-type cross this boundary, never native auth.
                      response.writeHead(upstream.status, {
                        'content-type':
                          upstream.headers.get('content-type') ??
                          'application/json',
                        'cache-control': 'no-store',
                      });
                      if (upstream.body) {
                        const reader = upstream.body.getReader();
                        const cancel = () => {
                          void reader.cancel(reading.reason).catch(() => {});
                        };
                        reading.addEventListener('abort', cancel, {
                          once: true,
                        });
                        try {
                          while (true) {
                            const part = await reader.read();
                            if (part.done) break;
                            await assertPinned(reading);
                            if (!response.write(part.value))
                              await once(response, 'drain', {
                                signal: reading,
                              });
                          }
                        } finally {
                          reading.removeEventListener('abort', cancel);
                          await reader.cancel();
                          reader.releaseLock();
                        }
                      }
                    },
                  },
                  active,
                );
              } catch (error) {
                void catalog.close().catch(() => {});
                cleanupErrors.push(error);
                throw error;
              }
            }
            let closing: Promise<void> | undefined;
            let task: Promise<void> | undefined;
            return {
              run(running: AbortSignal) {
                return (task = (async () => {
                  const authorize = async (
                    nativeSessionId: string,
                    effect: 'read' | 'write',
                    checking: AbortSignal,
                  ) => {
                    await assertPinned(checking);
                    const resource = await resolveDEntryNativeResource({
                      ...auth,
                      owner: catalog.owner,
                      nativeSessionId,
                      signal: checking,
                      root: deps.root,
                    });
                    if (
                      resource.rootNativeSessionId !==
                        pin.rootNativeSessionId ||
                      (effect === 'write' &&
                        (resource.nativeSessionId !== pin.rootNativeSessionId ||
                          resource.parentNativeSessionId !== null))
                    )
                      throw new DataAccessError('authorization_denied');
                    return resource;
                  };
                  if (parsed && rpc) {
                    await authorizeDEntryNativeInvocation(
                      authorize,
                      rpc.endpoint,
                      rpc.payload,
                      'http',
                      running,
                    );
                    running.throwIfAborted();
                    await activity!.run(running); // First native write/dispatch, after real resource authorization.
                  } else if (resourceRequest)
                    value = await authorize(
                      resourceRequest.nativeSessionId,
                      'read',
                      running,
                    );
                })());
              },
              close() {
                return (closing ??= (async () => {
                  const results = await Promise.allSettled([
                    activity
                      ? Promise.resolve().then(() => activity!.close())
                      : undefined,
                    catalog.close(),
                    task?.catch(() => {}), // Join the controlled run; close failures stay rejected below.
                  ]);
                  const errors = results.flatMap((result) =>
                    result.status === 'rejected' ? [result.reason] : [],
                  );
                  if (errors.length) {
                    const error = new AggregateError(
                      errors,
                      'D entry request close is unknown',
                      { cause: errors[0] },
                    );
                    cleanupErrors.push(error);
                    throw error;
                  }
                })());
              },
            };
          },
        );
        await assertPinned(current.signal);
        if (rpc) response.end();
        else
          response
            .writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            .end(JSON.stringify(value));
      } else {
        await assertCurrent(current.signal);
        response.writeHead(200, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(
          JSON.stringify({ identity: auth.identity, ...current.view }),
        );
      }
    } catch (error) {
      sendDEntryHttpProblem(
        response,
        parsedInput && error instanceof z.ZodError
          ? new DEntryNativeUnavailable()
          : error,
      );
    } finally {
      response.off('close', disconnect);
      response.off('error', responseError);
      signal.removeEventListener('abort', cancelBody);
    }
    return true;
  };
  return Object.assign(
    (request: IncomingMessage, response: ServerResponse, stopping = false) => {
      const operation = handle(request, response, stopping);
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    },
    {
      close() {
        if (closing) return closing;
        lifetime.abort();
        closing = (async () => {
          await Promise.allSettled([...pending]);
          if (cleanupErrors.length)
            throw new AggregateError(
              cleanupErrors,
              'D entry HTTP cleanup is unknown',
            );
        })();
        return closing;
      },
    },
  );
}
