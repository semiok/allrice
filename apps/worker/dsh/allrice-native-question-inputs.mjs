import { createHash } from 'node:crypto';
import {
  UserQuestionAnswerSubmissionSchema,
  matchUserQuestionAnswer,
} from '@allrice/contracts/native-runtime';

const prefix = 'allrice:user-question:v1:';
const hash = (input) =>
  createHash('sha256')
    .update(JSON.stringify([input.inputId, input.kind, input.text]))
    .digest('hex');
const batch = (answers) =>
  JSON.stringify(
    answers.map((a) => ({
      id: a.id,
      selected: a.selected,
      ...(a.custom ? { custom: a.custom } : {}),
    })),
  );
function submission(input, sessionId) {
  if (!input.text.startsWith(prefix)) throw Error('QUESTION_ANSWER_INVALID');
  const answer = UserQuestionAnswerSubmissionSchema.parse(
    JSON.parse(input.text.slice(prefix.length)),
  );
  if (!answer.questionId.startsWith(`${sessionId}:`))
    throw Error('QUESTION_EXPIRED');
  return answer;
}

/** Evidence is DSH's settled batch plus its durable tool result/user message.
 * A request receipt or answer() ACK cannot settle an AllRice command. */
export function inspectNativeQuestionInput(agent, input, view) {
  const events = agent.session.snapshotEvents();
  const bound = events.findLast(
    (e) =>
      e.type === 'allrice/input/request' && e.data.inputId === input.inputId,
  );
  if (!bound) return { status: 'not_found' };
  if (!bound.data.nativeQuestion || bound.data.digest !== hash(input))
    throw Error('INPUT_ID_CONFLICT');
  const { callId, messageId, answers } = bound.data;
  const pending = { status: 'pending', inputId: input.inputId, messageId };
  const settled = view.settled.find((q) => q.callId === callId);
  if (!settled) {
    if (view.active.some((q) => q.callId === callId)) return pending;
    throw Error('QUESTION_EXPIRED');
  }
  if (batch(settled.answers) !== batch(answers))
    throw Error('QUESTION_ANSWER_NOT_ADOPTED');
  const proof = events.findLast(
    (e) =>
      (e.type === 'tool/result' && e.data.message.toolCallId === callId) ||
      (e.type === 'user/message' &&
        e.data.source.kind === 'user-question-reply' &&
        e.data.source.callId === callId),
  );
  const turn =
    proof &&
    events.findLast((e) => e.type === 'turn/start' && e.seq < proof.seq)?.data
      .turn;
  if (!proof || turn === undefined) return { ...pending, status: 'unknown' };
  return {
    status: 'adopted',
    inputId: input.inputId,
    messageId,
    callId,
    sequence: proof.seq,
    turnId: `${agent.session.id}:turn:${turn}`,
    checkpoint:
      proof.type === 'user/message' ? 'question_replied' : 'question_resolved',
  };
}

/** The only replayable operation is DSH answer(): its own queued-reply guard
 * prevents duplicate insertion; a discarded reply leaves the call continued. */
export async function deliverNativeQuestionInput(scope, input) {
  const {
    agent,
    sessionId,
    questionView,
    pendingQuestion,
    flush,
    isCurrent,
    notify,
    answerQuestion,
    allowIdle,
  } = scope;
  const answer = submission(input, sessionId);
  const callId = answer.questionId.slice(sessionId.length + 1);
  const inspect = () =>
    inspectNativeQuestionInput(agent, input, questionView());
  const previous = inspect();
  if (previous.status === 'adopted' || previous.status === 'unknown') {
    await flush();
    return previous;
  }
  if (agent.status !== 'running' && !(allowIdle && agent.status === 'idle'))
    throw Error('INPUT_TURN_CHANGED');
  const view = questionView();
  const q = view.active.find((item) => item.callId === callId);
  const matched = q
    ? matchUserQuestionAnswer(
        { questionId: answer.questionId, questions: q.questions },
        answer,
      )
    : null;
  if (q && !matched) throw Error('QUESTION_ANSWER_INVALID');
  if (!q && !view.settled.some((item) => item.callId === callId))
    throw Error('QUESTION_EXPIRED');
  if (previous.status === 'not_found') {
    agent.session.append('allrice/input/request', {
      inputId: input.inputId,
      digest: hash(input),
      nativeQuestion: true,
      callId,
      messageId: answer.questionId,
      answers: matched?.answers ?? answer.answers,
    });
    await flush();
  }
  if (!isCurrent()) return inspect();
  if (!q) return inspect();
  if (q.state === 'open') {
    if (pendingQuestion?.questionId !== answer.questionId)
      throw Error('QUESTION_EXPIRED');
    pendingQuestion.resolve(matched);
    notify();
  } else {
    try {
      answerQuestion(callId, matched);
    } catch (error) {
      if (error?.code !== 'REPLY_QUEUED') throw error;
    }
  }
  await flush();
  return inspect();
}
