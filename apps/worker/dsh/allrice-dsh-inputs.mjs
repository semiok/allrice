import { createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { structuredUserQuestionAnswer } from './allrice-dsh-runtime-compatibility.mjs';
import {
  deliverNativeQuestionInput,
  inspectNativeQuestionInput,
} from './allrice-native-question-inputs.mjs';

// Pinned rc.3 has no downstream event registration API. Extend only
// this private vocabulary; never suppress the unknown-event recovery guard.
for (const type of ['allrice/input/request', 'allrice/input/answered'])
  KNOWN_SESSION_EVENT_TYPES.add(type);

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (input) =>
  `sha256:${createHash('sha256')
    .update(
      JSON.stringify([input.inputId, input.turnId, input.kind, input.text]),
    )
    .digest('hex')}`;

/** Read actual native journal facts; inbox admission alone is not step adoption.
 * Uses pinned native DSH events, not a model's promise or guessed timing. */
export function inspectDshInput(agent, input, questionView) {
  const events = agent.session.snapshotEvents();
  const bound = events.findLast(
    (e) =>
      e.type === 'allrice/input/request' && e.data.inputId === input.inputId,
  );
  if (!bound) return { status: 'not_found' };
  if (bound.data.nativeQuestion && questionView)
    return inspectNativeQuestionInput(agent, input, questionView());
  if (bound.data.digest !== digest(input))
    throw new TypeError('INPUT_ID_CONFLICT');
  const answer = events.findLast(
    (e) =>
      e.type === 'allrice/input/answered' && e.data.inputId === input.inputId,
  );
  const entered = events.findLast(
    (e) => e.type === 'user/message' && e.data.id === bound.data.messageId,
  );
  let proof = answer ?? entered;
  const prefix = `${agent.session.id}:`;
  const callId =
    input.kind === 'ask_user' && bound.data.messageId.startsWith(prefix)
      ? bound.data.messageId.slice(prefix.length)
      : undefined;
  const view = callId && questionView?.();
  const nativeQuestion =
    view &&
    ([...view.active, ...view.settled].some((q) => q.callId === callId) ||
      events.some(
        (e) =>
          e.type === 'tool/call' &&
          e.data.callId === callId &&
          e.data.name === 'ask_user_question',
      ));
  if (nativeQuestion) {
    const settled = view.settled.find((q) => q.callId === callId);
    const native = events.findLast(
      (e) =>
        (e.type === 'tool/result' && e.data.message.toolCallId === callId) ||
        (e.type === 'user/message' &&
          e.data.source.kind === 'user-question-reply' &&
          e.data.source.callId === callId),
    );
    if (!settled || !native)
      return {
        status: native ? 'unknown' : 'pending',
        inputId: input.inputId,
        messageId: bound.data.messageId,
      };
    proof = native;
  }
  if (proof) {
    const nativeTurn = events.findLast(
      (e) => e.type === 'turn/start' && e.seq < proof.seq,
    )?.data.turn;
    // Do not manufacture evidence for the requested turn if an inbox entry
    // somehow crossed a turn boundary during recovery.
    if (
      bound.data.turnId !== input.turnId ||
      !input.turnId.endsWith(`:turn:${nativeTurn}`)
    )
      return {
        status: 'unknown',
        inputId: input.inputId,
        messageId: bound.data.messageId,
      };
  }
  if (proof)
    return {
      status: 'adopted',
      inputId: input.inputId,
      messageId: bound.data.messageId,
      sequence: proof.seq,
      turnId: input.turnId,
      checkpoint: answer ? 'question_resolved' : 'step_user_message',
      ...(nativeQuestion
        ? {
            callId,
            checkpoint:
              proof.type === 'user/message'
                ? 'question_replied'
                : 'question_resolved',
          }
        : {}),
    };
  const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(
    (m) => m.id === bound.data.messageId,
  );
  if (pending)
    return {
      status: 'pending',
      inputId: input.inputId,
      messageId: bound.data.messageId,
    };
  return {
    status: 'unknown',
    inputId: input.inputId,
    messageId: bound.data.messageId,
  };
}

/** Idempotent within DSH's own persisted journal, including RPC ACK loss.
 * A record without native insertion/adoption is unknown and is never replayed. */
export async function deliverDshInput(
  {
    agent,
    sessionId,
    pendingQuestion,
    notify,
    flush,
    isCurrent,
    suspended = false,
    questionView,
    answerQuestion,
    allowIdle = false,
  },
  input,
) {
  if (
    !uuid.test(input.inputId) ||
    !['steer_current', 'ask_user'].includes(input.kind) ||
    typeof input.text !== 'string' ||
    !input.text.trim() ||
    input.text.length > 80_000
  )
    throw new TypeError('INVALID_TYPED_INPUT');
  if (input.kind === 'ask_user' && questionView && answerQuestion)
    return deliverNativeQuestionInput(
      {
        agent,
        sessionId,
        pendingQuestion,
        notify,
        flush,
        isCurrent,
        questionView,
        answerQuestion,
        allowIdle,
      },
      input,
    );
  const inspect = () => inspectDshInput(agent, input, questionView);
  const previous = inspect();
  if (previous.status !== 'not_found') {
    await flush();
    return previous;
  }
  const turn = agent.session
    .snapshotEvents()
    .findLast((e) => e.type === 'turn/start')?.data.turn;
  if (
    agent.status !== (suspended ? 'idle' : 'running') ||
    input.turnId !== `${sessionId}:turn:${turn}`
  )
    throw new TypeError('INPUT_TURN_CHANGED');
  if (input.kind === 'ask_user') {
    if (!pendingQuestion) throw new TypeError('QUESTION_EXPIRED');
    let answer;
    try {
      answer = structuredUserQuestionAnswer(pendingQuestion, input.text);
    } catch {
      throw new TypeError('QUESTION_ANSWER_INVALID');
    }
    // structuredUserQuestionAnswer applied the one shared answer rule; a
    // skipped item ({ id, selected: [] }) is an answer (DSH, MET-210).
    if (!answer) throw new TypeError('QUESTION_ANSWER_REQUIRED');
    agent.session.append('allrice/input/request', {
      inputId: input.inputId,
      digest: digest(input),
      messageId: pendingQuestion.questionId,
      turnId: input.turnId,
    });
    await flush();
    if (!isCurrent()) return inspect();
    pendingQuestion.resolve(answer);
    agent.session.append('allrice/input/answered', {
      inputId: input.inputId,
      questionId: pendingQuestion.questionId,
      turnId: input.turnId,
    });
    notify();
  } else {
    // A general correction must never answer an outstanding form by accident.
    if (pendingQuestion) throw new TypeError('QUESTION_PENDING_USE_ANSWER');
    const message = createUserMessage({
      content: [{ type: 'text', text: input.text }],
      source: { kind: 'user' },
    });
    agent.session.append('allrice/input/request', {
      inputId: input.inputId,
      digest: digest(input),
      messageId: message.id,
      turnId: input.turnId,
    });
    await flush();
    if (!isCurrent() || agent.status !== 'running') return inspect();
    agent.steer(message);
  }
  await flush();
  return inspect();
}

/** Do not let an old turn's unadopted correction leak into a later turn. */
export function discardPendingDshInputs(agent) {
  const ownIds = new Set(
    agent.session
      .snapshotEvents()
      .filter((e) => e.type === 'allrice/input/request')
      .map((e) => e.data.messageId),
  );
  for (const message of [...agent.inbox.nextStep, ...agent.inbox.nextTurn]) {
    if (ownIds.has(message.id)) agent.inbox.remove(message.id);
  }
}
