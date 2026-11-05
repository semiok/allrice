import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import {
  RuntimeActionApprovalRequestSchema,
  RuntimeActionApprovalResponseSchema,
  matchesRuntimeInteractionResponse,
  runtimeContractEqual,
} from '@allrice/contracts/native-runtime';

/* global AbortSignal */

/** Transport an answer to the live native waterfall. There is no pending
 * registry or restored permission: the only handlers are borrowed by the
 * current tool invocation and removed when DSH settles/cancels it. */
export function installNativeActionApproval(server) {
  const { ctx } = server;
  const event = (kind) => `allrice/native-action/${kind}`;
  const requireRoot = (sessionId) => {
    const root = server.requireRoot(sessionId);
    if (server.runAdmission?.rootFor(root.agent) !== root.agent)
      throw Error('NATIVE_ACTION_ROOT_REQUIRED');
    return root;
  };
  return {
    async handle(kind, params) {
      requireRoot(params.sessionId);
      const result = await ctx.serial(event(kind), params);
      if (result === undefined) throw Error('NATIVE_ACTION_NOT_LIVE');
      return result;
    },
    async withCall({ agent, callId, toolName, signal }, execute) {
      let requested = false;
      let allowed;
      const verify = ctx.on(event('verify'), (params) => {
        if (params.sessionId !== agent.id || params.callId !== callId) return;
        signal.throwIfAborted();
        if (
          !allowed ||
          params.requestId !== allowed.requestId ||
          requireRoot(agent.id).agent !== agent ||
          Date.parse(allowed.expiresAt) <= Date.now()
        )
          throw Error('NATIVE_ACTION_NOT_LIVE');
        return { live: true };
      });
      const dispose = ctx.on(event('request'), async (params) => {
        if (params.sessionId !== agent.id || params.callId !== callId) return;
        const root = requireRoot(agent.id);
        if (root.agent !== agent || signal.aborted)
          throw Error('NATIVE_ACTION_NOT_LIVE');
        const request = RuntimeActionApprovalRequestSchema.parse(
          params.request,
        );
        const run = server.runAdmission.attribute({
          nativeSessionId: agent.id,
        });
        if (request.task.runId !== run.runId || requested)
          throw Error('NATIVE_ACTION_SCOPE_MISMATCH');
        requested = true;
        const liveSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(
            Math.max(1, Date.parse(request.expiresAt) - Date.now()),
          ),
        ]);
        const native = {
          agent,
          toolName,
          callId,
          signal: liveSignal,
          reason:
            'Confirm the exact prepared AllRice action shown in this operation.',
        };
        let accepted = null;
        const answerer = ctx.on('approval/request', async (received, next) => {
          if (received !== native) return next();
          let answer;
          const responding = new Promise((resolve) => {
            answer = resolve;
          });
          const matches = (query) =>
            query.sessionId === agent.id &&
            query.approvalId === request.approvalId &&
            query.actorId === request.respondentId &&
            query.runId === request.task.runId;
          const current = () => {
            liveSignal.throwIfAborted();
            server.assertRoot(root, agent.id);
            if (
              server.runAdmission.attribute({ nativeSessionId: agent.id })
                .runId !== run.runId
            )
              throw Error('NATIVE_ACTION_SCOPE_MISMATCH');
          };
          const read = ctx.on(event('read'), (query) => {
            if (!matches(query)) return;
            current();
            return {
              request,
              response: accepted,
              consumedAt: null,
              revokedAt: null,
            };
          });
          const reply = ctx.on(event('answer'), (query) => {
            if (!matches(query)) return;
            current();
            const submitted = RuntimeActionApprovalResponseSchema.parse(
              query.response,
            );
            const response = {
              ...submitted,
              respondedAt: accepted?.respondedAt ?? new Date().toISOString(),
            };
            if (
              !matchesRuntimeInteractionResponse(request, response, {
                trustedScope: request.task.scope,
                task: request.task,
                respondentId: request.respondentId,
                activeTurn: null,
                now: new Date().toISOString(),
              }) ||
              (accepted && !runtimeContractEqual(accepted, response))
            )
              throw Error('NATIVE_ACTION_RESPONSE_MISMATCH');
            accepted = response;
            answer(
              response.decision === 'approved' ? 'allowed-once' : 'rejected',
            );
            return { response };
          });
          const abort = () => answer('cancelled');
          liveSignal.addEventListener('abort', abort, { once: true });
          if (liveSignal.aborted) abort();
          try {
            return await responding;
          } finally {
            liveSignal.removeEventListener('abort', abort);
            read();
            reply();
          }
        });
        try {
          // The deployment remains never. Only this verified interactive root
          // adopts ask; public DSH delegation still seeds every child as never.
          setApprovalPolicy(agent.session, 'ask');
          const outcome = await ctx.approval.request(native);
          if (outcome === 'allowed-once' && !liveSignal.aborted)
            allowed = request;
          return { outcome, request, response: accepted };
        } finally {
          answerer();
        }
      });
      try {
        return await execute();
      } finally {
        dispose();
        verify();
      }
    },
  };
}
