import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import {
  NativeRunDiagnosticsRequestSchema,
  NativeSubagentQueryRequestSchema,
  NativeSubagentFollowEventSchema,
} from '@allrice/contracts';
import {
  authenticateSession,
  getRunNativeDiagnosticTarget,
  getSessionNativeSubagentTarget,
  nativeRootDigest,
} from '@allrice/database';
import { readNativeRunDiagnostics } from './harness/native-run-diagnostics.js';
import {
  nativeSubagentQuerySource,
  readAuthorizedNativeSubagentSummary,
} from './harness/native-subagent-query.js';
import { getHarnessRouter } from './harness/router.js';

type Dependencies = {
  authenticate: typeof authenticateSession;
  target: typeof getRunNativeDiagnosticTarget;
  read: typeof readNativeRunDiagnostics;
};
const defaults: Dependencies = {
  authenticate: authenticateSession,
  target: getRunNativeDiagnosticTarget,
  read: readNativeRunDiagnostics,
};

/** A narrow ordinary-user read on the existing Worker listener. Web and Worker
 * each authenticate the real session; no admin impersonation or caller paths. */
export function createNativeRunDiagnosticsHttpHandler(
  deps: Dependencies = defaults,
  subagents = {
    target: getSessionNativeSubagentTarget,
    read: readAuthorizedNativeSubagentSummary,
  },
  serviceSignal?: AbortSignal,
) {
  let active = 0;
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    stopping = false,
  ): Promise<boolean> => {
    const summaryRequest = request.url === '/internal/native-subagent-summary';
    if (!summaryRequest && request.url !== '/internal/native-run-diagnostics')
      return false;
    const send = (status: number, body: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'POST' || request.headers.origin) {
      send(404, { error: 'not_found' });
      return true;
    }
    if (
      stopping ||
      serviceSignal?.aborted ||
      (!summaryRequest && active >= 2)
    ) {
      send(503, { error: 'diagnostics_unavailable' });
      return true;
    }
    const bearer = request.headers.authorization;
    if (!bearer || !/^Bearer [A-Za-z0-9_-]{16,4096}$/.test(bearer)) {
      send(401, { error: 'authentication_required' });
      return true;
    }
    const token = bearer.slice(7),
      abort = new AbortController();
    const onClose = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.once('close', onClose);
    const signal = summaryRequest
      ? AbortSignal.any([
          abort.signal,
          ...(serviceSignal ? [serviceSignal] : []),
        ])
      : AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
    const cancelRead = () => {
      // A complete summary response drains only after the reader's finally.
      if (!summaryRequest || !request.complete) request.destroy();
    };
    signal.addEventListener('abort', cancelRead, { once: true });
    if (!summaryRequest) active++;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > 4096) {
          send(400, { error: 'invalid_request' });
          return true;
        }
        chunks.push(Buffer.from(chunk));
      }
      const parsed = (
        summaryRequest
          ? NativeSubagentQueryRequestSchema
          : NativeRunDiagnosticsRequestSchema
      ).safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (!parsed.success) {
        send(400, { error: 'invalid_request' });
        return true;
      }
      const input = parsed.data;
      const tenant = {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
      };
      const context = await deps.authenticate(token, tenant);
      if (!context) {
        send(401, { error: 'authentication_required' });
        return true;
      }
      if ('sessionId' in input) {
        const target = await subagents.target(
          context,
          input.workspaceId,
          input.sessionId,
        );
        signal.throwIfAborted();
        const check = async (checkSignal = signal) => {
          checkSignal.throwIfAborted();
          const current = await deps.authenticate(token, tenant);
          checkSignal.throwIfAborted();
          if (!current || current.actor.id !== context.actor.id)
            throw Object.assign(Error('authentication_required'), {
              code: 'authentication_required',
            });
          const after = await subagents.target(
            current,
            input.workspaceId,
            input.sessionId,
          );
          checkSignal.throwIfAborted();
          if (nativeRootDigest(after) !== nativeRootDigest(target))
            throw Error('NATIVE_QUERY_TARGET_CHANGED');
          if (input.follow) nativeSubagentQuerySource(after);
          signal.throwIfAborted();
        };
        if (input.follow) {
          nativeSubagentQuerySource(target);
          const followed = await getHarnessRouter()
            .resolve('dsh')
            .nativeSubagentFollow?.(target, {
              childId: input.childId,
              signal,
              check,
              terminal: () => subagents.read(target, signal, false),
              send: async (event, followSignal) => {
                followSignal.throwIfAborted();
                if (
                  !event &&
                  (!response.headersSent || response.writableNeedDrain)
                )
                  return;
                if (!response.headersSent)
                  response.writeHead(200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache, no-transform',
                    'x-accel-buffering': 'no',
                  });
                const data = event
                  ? `data: ${JSON.stringify(NativeSubagentFollowEventSchema.parse(event))}\n\n`
                  : ': heartbeat\n\n';
                if (!response.write(data))
                  await once(response, 'drain', { signal: followSignal });
              },
            });
          if (!followed) throw Error('NATIVE_QUERY_HOST_UNAVAILABLE');
          response.end();
          return true;
        }
        const summary = await subagents.read(target, signal, input.liveOnly);
        await check();
        send(200, { sessionId: input.sessionId, summary });
        return true;
      }
      const target = await deps.target(context, input.workspaceId, input.runId);
      signal.throwIfAborted();
      const diagnostics = await deps.read(target, signal);
      // Reading may outlive a logout, membership change or Run visibility edit.
      const current = await deps.authenticate(token, tenant);
      if (!current || current.actor.id !== context.actor.id) {
        send(401, { error: 'authentication_required' });
        return true;
      }
      await deps.target(current, input.workspaceId, input.runId);
      signal.throwIfAborted();
      send(200, { diagnostics });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return true;
      if (response.headersSent) {
        if (response.writableNeedDrain) response.destroy();
        else response.end('data: {"type":"clear","reason":"unavailable"}\n\n');
        return true;
      }
      const code =
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : undefined;
      if (code === 'authentication_required')
        send(401, { error: 'authentication_required' });
      else if (
        code === 'not_found' ||
        code === 'authorization_denied' ||
        code === 'tenant_context_invalid'
      )
        send(404, { error: 'not_found' });
      else if (error instanceof SyntaxError)
        send(400, { error: 'invalid_request' });
      else send(503, { error: 'diagnostics_unavailable' });
    } finally {
      if (!summaryRequest) active--;
      response.off('close', onClose);
      signal.removeEventListener('abort', cancelRead);
    }
    return true;
  };
}
