import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const REPAIR_SOURCE = 'allrice-final-delivery-repair';
export const digestText = (text) =>
  `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
const repairIssues = new Set([
  'invalid_delivery_link',
  'missing_delivery_link',
  'empty_response',
]);
const fail = (code) =>
  Object.assign(new Error(code), { code, retryable: false });
const textOf = (event) =>
  event.data.message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
const currentTurn = (agent) =>
  agent.session
    .snapshotEvents()
    .findLast((event) => event.type === 'turn/start')?.data.turn;

/** One same-Agent/same-turn text-only continuation. All ports are private host
 * closures; none are model tools. Existing native admission remains the sole
 * model-call ledger. The original assistant message is never rewritten. */
export function createBoundedFinalDeliveryRepair(ctx, ports) {
  const states = new Map();
  for (const name of [
    'binding',
    'inspect',
    'authorize',
    'acquireInputDelivery',
    'prepare',
    'consumePreparation',
    'closePreparation',
    'quiescent',
  ])
    if (typeof ports?.[name] !== 'function')
      throw fail('FINAL_DELIVERY_REPAIR_PORTS_REQUIRED');
  const same = (state) =>
    state.binding === ports.binding(state.id) &&
    state.agent === ctx.agents.get(state.id) &&
    state.turn === currentTurn(state.agent);
  const pendingInput = (state) =>
    [...state.agent.inbox.nextStep, ...state.agent.inbox.nextTurn].some(
      (message) => message.id !== state.noticeId,
    );
  function active(id) {
    const state = states.get(id);
    return state &&
      same(state) &&
      ['queued', 'prepared', 'dispatched'].includes(state.phase)
      ? state
      : undefined;
  }
  function candidate(agent, turn, afterSeq) {
    const event = agent.session
      .snapshotEvents()
      .findLast(
        (entry) =>
          entry.type === 'assistant/message' &&
          entry.data.turn === turn &&
          entry.seq > afterSeq,
      );
    const message = event?.data.message;
    if (
      !event ||
      event.data.interrupted ||
      message?.source?.kind !== 'model' ||
      message.content.some(
        (block) => !['text', 'reasoning'].includes(block.type),
      )
    )
      return null;
    return Object.freeze({
      nativeSessionId: agent.id,
      turn,
      publicMessageId: message.id,
      durableSeq: event.seq,
      text: textOf(event),
      candidateDigest: digestText(textOf(event)),
      provider: message.source.provider,
      model: message.source.model,
    });
  }
  function inspection(value, source) {
    if (
      !value ||
      value.candidateDigest !== source.candidateDigest ||
      !['pass', 'repair', 'blocked'].includes(value.decision) ||
      !/^sha256:[a-f0-9]{64}$/.test(value.factSetDigest)
    )
      throw fail('FINAL_DELIVERY_REPAIR_EVIDENCE_UNAVAILABLE');
    if (value.decision !== 'repair') return value;
    if (
      !Array.isArray(value.issues) ||
      !value.issues.length ||
      value.issues.some((issue) => !repairIssues.has(issue)) ||
      !Array.isArray(value.references) ||
      value.references.length > 32
    )
      throw fail('FINAL_DELIVERY_REPAIR_EVIDENCE_UNAVAILABLE');
    for (const ref of value.references) {
      if (
        !ref ||
        !/^[a-f0-9-]{36}$/i.test(ref.objectId) ||
        !/^[a-f0-9-]{36}$/i.test(ref.versionId) ||
        !/^sha256:[a-f0-9]{64}$/.test(ref.checksum) ||
        typeof ref.displayName !== 'string' ||
        !ref.displayName.trim() ||
        ref.downloadUrl !== `/api/v1/files/${ref.objectId}/download`
      )
        throw fail('FINAL_DELIVERY_REPAIR_EVIDENCE_UNAVAILABLE');
    }
    return value;
  }
  async function authorize(state, phase, signal, request) {
    signal?.throwIfAborted();
    if (!same(state) || pendingInput(state) || !state.gate?.stillCurrent())
      throw fail('FINAL_DELIVERY_REPAIR_INPUT_CONFLICT');
    const authority = await ports.authorize({
      phase,
      candidate: state.original,
      signal,
      request,
    });
    signal?.throwIfAborted();
    if (!same(state) || pendingInput(state) || !state.gate.stillCurrent())
      throw fail('FINAL_DELIVERY_REPAIR_INPUT_CONFLICT');
    if (
      !authority ||
      authority.allowed !== true ||
      authority.runId !== state.binding.runId ||
      !Number.isSafeInteger(authority.generation) ||
      authority.generation < 1 ||
      !Number.isSafeInteger(authority.attempt) ||
      authority.attempt < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(authority.workerLeaseDigest) ||
      !Number.isFinite(authority.originalDeadlineAt) ||
      Date.now() >= authority.originalDeadlineAt ||
      authority.provider !== state.original.provider ||
      authority.model !== state.original.model
    )
      throw fail('FINAL_DELIVERY_REPAIR_AUTHORITY_UNAVAILABLE');
    const identity = JSON.stringify([
      authority.runId,
      authority.generation,
      authority.attempt,
      authority.workerLeaseDigest,
      authority.originalDeadlineAt,
      authority.provider,
      authority.model,
    ]);
    if (state.authorityIdentity && state.authorityIdentity !== identity)
      throw fail('FINAL_DELIVERY_REPAIR_AUTHORITY_CHANGED');
    if (
      phase === 'propose' &&
      (!Number.isSafeInteger(authority.remainingModelCalls) ||
        authority.remainingModelCalls < 1 ||
        !Number.isSafeInteger(authority.remainingOutputTokens) ||
        authority.remainingOutputTokens < 1)
    )
      throw fail('FINAL_DELIVERY_REPAIR_BUDGET_UNAVAILABLE');
    state.authorityIdentity = identity;
    return authority;
  }
  async function release(state) {
    if (!state.gate) return;
    state.release ??= state.gate.releaseBeforeTurnClose();
    await state.release;
  }
  function cleanup(state) {
    // Consumption only hands a prepared ticket to DSH; it is not dispatch.
    // One observed cleanup asks the existing DB transaction to arbitrate any
    // uncommitted/unknown dispatch. Never infer unused usage from a local error.
    state.cleanup ??= Promise.resolve().then(async () => {
      const failures = [];
      try {
        if (state.ticket) {
          await ports.closePreparation(state.id, state.ticket);
          state.ticket = undefined;
        }
      } catch (error) {
        failures.push(error);
      }
      try {
        // Cancel only this helper's own still-pending host notice. Its original
        // journal record remains; real inputs retain their IDs/source/queue.
        if (state.noticeId)
          for (const message of [
            ...state.agent.inbox.nextStep,
            ...state.agent.inbox.nextTurn,
          ])
            if (
              message.id === state.noticeId &&
              message.source?.kind === REPAIR_SOURCE
            )
              state.agent.inbox.remove(message.id);
      } catch (error) {
        failures.push(error);
      }
      try {
        await release(state);
      } catch (error) {
        failures.push(error);
      }
      state.signal?.removeEventListener('abort', state.onAbort);
      if (failures.length === 1) throw failures[0];
      if (failures.length)
        throw new AggregateError(
          failures,
          'FINAL_DELIVERY_REPAIR_CLEANUP_FAILED',
        );
    });
    return state.cleanup;
  }
  async function abandon(state) {
    state.phase = 'abandoned';
    await cleanup(state);
  }
  const denyTool = (exec) => {
    const state = active(exec.agent?.id);
    if (!state) return undefined;
    state.violation = true;
    return 'FINAL_DELIVERY_REPAIR_TOOLS_FORBIDDEN';
  };
  // Run before approval hooks; even an invented tool cannot produce a write.
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      const reason = denyTool(exec);
      return reason ? { kind: 'deny', reason } : next();
    },
    { prepend: true },
  );
  ctx.tools.guard(denyTool);
  ctx.on(
    'agent/request-error',
    async ({ agent }, next) => (active(agent.id) ? undefined : next()),
    { prepend: true },
  );
  ctx.on(
    'agent/pre-step',
    async ({ agent, messages }, next) => {
      const state = active(agent.id);
      const decision = await next();
      if (!state || decision.kind !== 'enter') return decision;
      // External business input must have been held at ingress. Preserve every
      // message on any violation; fail rather than reclassifying a human source.
      if (
        messages.some((message) => message.id !== state.noticeId) ||
        pendingInput(state)
      )
        throw fail('FINAL_DELIVERY_REPAIR_INPUT_CONFLICT');
      return decision;
    },
    { prepend: true },
  );
  const stopped = ({ agent }) => {
    const state = states.get(agent.id);
    if (state?.gate && state.agent === agent) {
      state.phase = 'failed';
      // Emit-only edges cannot await. flush()/close() observe this SAME promise.
      void cleanup(state).catch(() => {});
    }
  };
  ctx.on('agent/error', stopped);
  ctx.on('agent/disposed', stopped);
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    const state = states.get(agent.id);
    if (!state || state.binding !== ports.binding(agent.id)) return;
    if (state.used) {
      if (
        state.turn !== turn ||
        ['finished', 'abandoned', 'failed'].includes(state.phase)
      )
        return;
      try {
        if (state.phase !== 'dispatched' || state.violation)
          throw fail('FINAL_DELIVERY_REPAIR_FAILED');
        const answer = candidate(agent, turn, state.original.durableSeq);
        if (!answer) throw fail('FINAL_DELIVERY_REPAIR_FAILED');
        const checked = inspection(await ports.inspect(answer, signal), answer);
        if (checked.decision !== 'pass')
          throw fail('FINAL_DELIVERY_REPAIR_FAILED');
        state.phase = 'finished';
      } finally {
        // Reopen and drain the original command queue while the native turn is
        // still running; any queued real input gets its original ID/source.
        await cleanup(state);
      }
      return;
    }
    // A failed cleanup is retained for close()/unbind, not re-armed by another
    // stopping notification in the same binding.
    if (state.phase === 'failed') return;
    state.agent = agent;
    state.turn = turn;
    if (pendingInput(state) || !ports.quiescent(agent.id)) return;
    const answer = candidate(agent, turn, state.afterSeq);
    if (!answer) return; // ask-user/child tool turn keeps its existing path.
    let checked = inspection(await ports.inspect(answer, signal), answer);
    if (checked.decision !== 'repair') return;
    state.original = answer;
    state.inspection = checked;
    try {
      state.gate = await ports.acquireInputDelivery({
        nativeSessionId: agent.id,
        turn,
        signal,
      });
      state.release = undefined;
      state.cleanup = undefined;
      state.signal = signal;
      state.onAbort = () => stopped({ agent });
      signal?.addEventListener('abort', state.onAbort, { once: true });
      if (pendingInput(state) || !ports.quiescent(agent.id))
        return await abandon(state);
      await authorize(state, 'propose', signal);
      // prepareModel is the existing ledger, run before steering the host notice.
      state.ticket = await ports.prepare(agent.id, signal);
      await authorize(state, 'prepared', signal);
      checked = inspection(await ports.inspect(answer, signal), answer);
      const exact = candidate(agent, turn, state.afterSeq);
      if (
        checked.decision !== 'repair' ||
        checked.factSetDigest !== state.inspection.factSetDigest ||
        exact?.publicMessageId !== answer.publicMessageId ||
        exact?.candidateDigest !== answer.candidateDigest ||
        pendingInput(state) ||
        !state.gate.stillCurrent()
      )
        return await abandon(state);
      state.used = true;
      state.phase = 'queued';
      const notice = finalDeliveryRepairNotice(answer, checked);
      // No asynchronous gap between the final gate check and same-turn steer.
      state.noticeId = notice.id;
      agent.steer(notice);
    } catch (error) {
      if (!state.noticeId) {
        await abandon(state);
        if (error.code === 'FINAL_DELIVERY_REPAIR_INPUT_CONFLICT') return;
      } else {
        state.phase = 'failed';
        await cleanup(state);
      }
      throw error;
    }
  });
  return Object.freeze({
    bind(id) {
      const binding = ports.binding(id);
      if (
        !binding ||
        binding.parentNativeSessionId ||
        binding.deliveryMode !== 'checked_native_v1'
      )
        return;
      const agent = ctx.agents.get(id);
      states.set(id, {
        id,
        binding,
        agent,
        used: false,
        phase: 'armed',
        afterSeq: agent?.session.snapshotEvents().at(-1)?.seq ?? -1,
      });
    },
    async takePreparation(id, signal) {
      const state = active(id);
      if (!state) return undefined;
      if (state.phase !== 'queued' || state.prepareConsumed || !state.ticket)
        throw fail('FINAL_DELIVERY_REPAIR_DISPATCH_LIMIT');
      await authorize(state, 'consume', signal);
      state.prepareConsumed = true;
      const outputTokens = ports.consumePreparation(id, state.ticket);
      state.phase = 'prepared';
      return outputTokens;
    },
    assertStreamEligible(options) {
      if (active(options.sessionId) && options.purpose === 'compaction')
        throw fail('FINAL_DELIVERY_REPAIR_DISPATCH_LIMIT');
    },
    async beforeDispatch(options) {
      const state = active(options.sessionId);
      if (!state) return;
      if (
        state.phase !== 'prepared' ||
        state.dispatchCount ||
        state.violation ||
        options.purpose === 'compaction'
      )
        throw fail('FINAL_DELIVERY_REPAIR_DISPATCH_LIMIT');
      state.dispatchCount = 1;
      if (
        options.provider !== state.original.provider ||
        options.model !== state.original.model
      )
        throw fail('FINAL_DELIVERY_REPAIR_AUTHORITY_CHANGED');
      await authorize(state, 'dispatch', options.signal);
      state.phase = 'dispatched';
    },
    assertNoEnvelope(id) {
      if (active(id)) throw fail('FINAL_DELIVERY_REPAIR_TOOLS_FORBIDDEN');
    },
    async flush() {
      await Promise.all(
        [...states.values()].flatMap((state) =>
          state.cleanup ? [state.cleanup] : [],
        ),
      );
    },
    async close(id) {
      const state = states.get(id);
      if (state) {
        state.phase = state.phase === 'finished' ? 'finished' : 'failed';
        await cleanup(state);
      }
      states.delete(id);
    },
  });
}

/** The platform notice is shared by legacy same-turn and post-wait repair. */
export function finalDeliveryRepairNotice(answer, checked) {
  return createUserMessage({
    source: {
      kind: REPAIR_SOURCE,
      form: 'notice',
      summary: 'AllRice 平台：仅修正最终交付说明，保留已有成果',
    },
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          origin: 'allrice-platform-host',
          operation: 'final-delivery-repair',
          originalMessageId: answer.publicMessageId,
          originalDigest: answer.candidateDigest,
          instructions:
            'This is platform-host context, not a human user message. ' +
            'Correct only the final reply using the exact existing references below. ' +
            'Remove unfinished editing instructions. Return the complete final answer. ' +
            'Do not use tools, ask questions, recreate files, change data, invent facts, ' +
            'or claim that an unsuccessful check passed. Preserve factual limitations. ' +
            'These instructions apply only to this one response, not later human inputs.',
          issues: checked.issues,
          references: checked.references,
        }),
      },
    ],
  });
}
