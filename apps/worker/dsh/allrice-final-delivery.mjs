import { randomUUID } from 'node:crypto';
import { treeQuiescent } from './allrice-agent-tree.mjs';
import {
  digestText,
  finalDeliveryRepairNotice,
} from './allrice-final-delivery-repair.mjs';
import { verifyRestoredFinalReplyOrigin } from './allrice-final-reply-origin.mjs';

/** Run-scoped SaaS completion capability over public DSH wait/log/maintenance.
 * DSH remains the only execution state machine. No assistant bridge or tables. */
export function createRunFinalDelivery(host) {
  const { ctx } = host;
  let binding;
  const fail = () => {
    throw Error('FINAL_DELIVERY_EVIDENCE_UNAVAILABLE');
  };
  const repairing = (agent) => binding?.agent === agent && binding.repair;
  const deny = (exec) => {
    const repair = repairing(exec.agent);
    if (!repair) return undefined;
    repair.violated = true;
    return 'FINAL_DELIVERY_REPAIR_TOOLS_FORBIDDEN';
  };
  ctx.tools.guard(deny);
  ctx.on(
    'tools/pre-execute',
    (exec, next) => {
      const reason = deny(exec);
      return reason ? { kind: 'deny', reason } : next();
    },
    { prepend: true },
  );
  ctx.on(
    'agent/request-error',
    ({ agent }, next) => (repairing(agent) ? undefined : next()),
    { prepend: true },
  );
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      const repair = binding?.repair;
      if (repair && options.sessionId === binding.agent.id) {
        if (
          options.purpose === 'compaction' ||
          repair.calls++ ||
          options.provider !== repair.provider ||
          options.model !== repair.model
        )
          fail();
        await host.transport.request('allrice/final-delivery-authorize', {
          nativeSessionId: binding.agent.id,
          rootRunId: binding.runId,
        });
        if (current().repair !== repair || binding.canceled) fail();
        options.signal?.throwIfAborted();
        // Existing content guard and task-progress accounting still run downstream.
      }
      yield* next();
    },
    { prepend: true },
  );
  function current() {
    const state = binding;
    if (!state || host.requireRoot(state.agent.id).agent !== state.agent)
      fail();
    return state;
  }
  function held(params) {
    const state = current();
    if (
      !state.hold ||
      params.completionToken !== state.token ||
      !treeQuiescent(state.agent) ||
      state.agent.status !== 'idle' ||
      state.agent.session.seq !== state.head
    )
      fail();
    return state;
  }
  async function release(state) {
    state.release();
    await state.hold;
    state.hold = undefined;
  }
  return {
    assertAccepting(id) {
      if (binding?.agent.id === id && binding.closing)
        throw Error('RUN_COMPLETING');
    },
    async handle(action, params) {
      if (action === 'bind') {
        if (binding?.hold || binding?.repair) fail();
        const { agent } = await host.ensureRoot(params.sessionId);
        if (typeof params.rootRunId !== 'string' || !params.rootRunId) fail();
        binding = {
          agent,
          runId: params.rootRunId,
          bindingId: randomUUID(),
          used: false,
          closing: false,
        };
        return { bound: true };
      }
      const state = current();
      if (params.sessionId !== state.agent.id) fail();
      if (action === 'candidate') {
        if (state.hold || state.acquiring) fail();
        state.acquiring = true;
        state.closing = true; // Synchronous ingress fence before the wait.
        await host.waitRoot(state.agent.id);
        if (current() !== state || !treeQuiescent(state.agent)) fail();
        const gate = new Promise((resolve) => {
          state.release = resolve;
        });
        state.hold = state.agent.runMaintenance(async (signal) => {
          const canceled = () => {
            state.canceled = true;
            state.release();
          };
          signal.addEventListener('abort', canceled, { once: true });
          try {
            await gate;
          } finally {
            signal.removeEventListener('abort', canceled);
          }
        });
        try {
          await host.taskProgress?.flush();
          await ctx.sessions.flush(state.agent.session);
          const { origin } = await host.transport.request(
            'allrice/final-delivery-origin',
            {
              nativeSessionId: state.agent.id,
              rootRunId: state.runId,
            },
          );
          if (
            current() !== state ||
            state.canceled ||
            !treeQuiescent(state.agent)
          )
            fail();
          const { event } = verifyRestoredFinalReplyOrigin(
            state.agent.session,
            state,
            origin,
          );
          const message = event.data.message;
          const answer = message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('');
          if (
            state.repair &&
            (state.repair.calls !== 1 ||
              state.repair.violated ||
              message.id === state.candidate.publicMessageId)
          )
            fail();
          state.repair = undefined;
          state.candidate = {
            answer,
            publicMessageId: message.id,
            durableSeq: event.seq,
            textDigest: digestText(answer),
            provider: message.source.provider,
            model: message.source.model,
            turn: event.data.turn,
            sourceEvent: {
              type: event.type,
              seq: event.seq,
              time: event.time,
              data: {
                turn: event.data.turn,
                step: event.data.step,
                message: {
                  content: message.content.map(({ type }) => ({ type })),
                },
              },
            },
          };
          state.head = state.agent.session.seq;
          state.token = randomUUID();
          state.acquiring = false;
          return {
            ...state.candidate,
            completionToken: state.token,
            rootBinding: {
              nativeSessionId: state.agent.id,
              runId: state.runId,
              bindingId: state.bindingId,
            },
          };
        } catch (error) {
          await release(state);
          throw error;
        }
      }
      held(params);
      if (state.canceled) fail();
      if (action === 'repair') {
        if (
          state.used ||
          params.inspection?.decision !== 'repair' ||
          params.inspection.candidateDigest !== state.candidate.textDigest
        )
          fail();
        state.used = true;
        state.repair = {
          provider: state.candidate.provider,
          model: state.candidate.model,
          calls: 0,
        };
        const notice = finalDeliveryRepairNotice(
          {
            publicMessageId: state.candidate.publicMessageId,
            candidateDigest: state.candidate.textDigest,
          },
          params.inspection,
        );
        await release(state);
        if (
          current() !== state ||
          !treeQuiescent(state.agent) ||
          state.canceled
        )
          fail();
        state.agent.steer(notice); // One native turn in the same business Run, after wait.
        return { accepted: true };
      }
      if (
        action !== 'finish' ||
        params.candidateDigest !== state.candidate.textDigest ||
        !/^sha256:[a-f0-9]{64}$/.test(params.factSetDigest)
      )
        fail();
      const receipt = {
        released: true,
        ...state.candidate,
        factSetDigest: params.factSetDigest,
      };
      await release(state);
      return receipt;
    },
  };
}
