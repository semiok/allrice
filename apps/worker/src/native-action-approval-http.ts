import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import {
  RuntimeActionApprovalResponseSchema,
  UuidSchema,
} from '@allrice/contracts';
import {
  authenticateSession,
  getNativeMcpApprovalTarget,
  getSessionNativeSubagentTarget,
} from '@allrice/database';
import { getHarnessRouter } from './harness/router.js';

const body = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    approvalId: UuidSchema,
    action: z.enum(['read', 'answer', 'cancel']),
    response: RuntimeActionApprovalResponseSchema.optional(),
  })
  .strict();
const defaults = {
  authenticate: authenticateSession,
  target: getNativeMcpApprovalTarget,
  sessionTarget: getSessionNativeSubagentTarget,
  exchange: async (
    target: Awaited<ReturnType<typeof getSessionNativeSubagentTarget>>,
    query: Record<string, unknown>,
    signal: AbortSignal,
  ) =>
    getHarnessRouter()
      .resolve('dsh')
      .nativeActionApproval?.(target, query, signal),
};

/** Short authenticated read/answer on the existing listener. This never opens
 * a Host, creates pending work or writes an independent PG approval. */
export function createNativeActionApprovalHttpHandler(
  deps = defaults,
  serviceSignal?: AbortSignal,
) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    stopping = false,
  ) => {
    if (request.url !== '/internal/native-action-approval') return false;
    const send = (status: number, value: unknown) => {
      if (response.destroyed) return;
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify(value));
    };
    if (request.method !== 'POST' || request.headers.origin) {
      send(404, {});
      return true;
    }
    if (stopping || serviceSignal?.aborted) {
      send(503, {});
      return true;
    }
    const bearer = request.headers.authorization;
    if (!bearer || !/^Bearer [A-Za-z0-9_-]{16,4096}$/.test(bearer)) {
      send(401, {});
      return true;
    }
    const abort = new AbortController();
    const closed = () => {
      if (!response.writableEnded) abort.abort();
    };
    response.once('close', closed);
    const signal = AbortSignal.any([
      abort.signal,
      AbortSignal.timeout(15_000),
      ...(serviceSignal ? [serviceSignal] : []),
    ]);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of request) {
        signal.throwIfAborted();
        size += part.length;
        if (size > 65_536) {
          send(413, {});
          return true;
        }
        chunks.push(Buffer.from(part));
      }
      const input = body.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      const token = bearer.slice(7),
        tenant = {
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
        };
      const context = await deps.authenticate(token, tenant);
      if (!context) {
        send(401, {});
        return true;
      }
      const locator = await deps.target(context, input.approvalId);
      if (!locator) {
        send(404, {});
        return true;
      }
      if (input.action === 'cancel' ? !locator.cutoff : locator.cutoff) {
        send(409, { code: 'NATIVE_ACTION_NOT_LIVE' });
        return true;
      }
      if (input.action !== 'cancel' && !locator.displayable) {
        send(409, { code: 'NATIVE_ACTION_NOT_DISPLAYABLE' });
        return true;
      }
      const target = await deps.sessionTarget(
        context,
        input.workspaceId,
        locator.sessionId,
      );
      const current = await deps.authenticate(token, tenant);
      if (!current || current.actor.id !== context.actor.id) {
        send(401, {});
        return true;
      }
      signal.throwIfAborted();
      const result = await deps.exchange(
        target,
        {
          action: input.action,
          approvalId: locator.approvalId,
          runId: locator.runId,
          actorId: current.actor.id,
          ...(input.action === 'answer' ? { response: input.response } : {}),
        },
        signal,
      );
      if (!result) throw Error('NATIVE_ACTION_NOT_LIVE');
      const after = await deps.authenticate(token, tenant);
      if (!after || after.actor.id !== context.actor.id) {
        send(401, {});
        return true;
      }
      const afterTarget = await deps.sessionTarget(
        after,
        input.workspaceId,
        locator.sessionId,
      );
      if (JSON.stringify(target) !== JSON.stringify(afterTarget))
        throw Error('NATIVE_ACTION_NOT_LIVE');
      signal.throwIfAborted();
      send(200, result);
    } catch {
      send(409, { code: 'NATIVE_ACTION_NOT_LIVE' });
    } finally {
      response.removeListener('close', closed);
    }
    return true;
  };
}
