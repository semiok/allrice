import { matchUserQuestionAnswer } from '@allrice/contracts/native-runtime';
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session';

// MET-210 timed questions. AllRice is only the lease here: the question's state
// stays DSH's own userQuestions projection, and a late answer is DSH's answer().

/** Use DSH's own recovery view, including requested but not started tools. */
function detachBoundary(server, agent) {
  if (
    server.ctx.agents.list().some((a) => a !== agent && a.status === 'running')
  )
    return { detached: false, reason: 'AGENTS_RUNNING' };
  const events = agent.session.snapshotEvents();
  const results = interruptedTurnClosers(events).filter(
    (e) => e.type === 'tool/result',
  );
  const callId = results[0]?.data.message.toolCallId;
  if (
    results.length !== 1 ||
    results[0].data.error?.code !== 'TOOL_OUTCOME_UNKNOWN' ||
    !events.some(
      (e) =>
        e.type === 'tool/call' &&
        e.data.callId === callId &&
        e.data.name === 'ask_user_question',
    )
  )
    return { detached: false, reason: 'TOOL_CALLS_OPEN' };
  return { detached: true, callId };
}

/**
 * Release the Host while its root waits only on one user question. It never
 * cancels: cancel would record ASK_ABORTED and DSH drops the question. The
 * journal instead stops after the tool call, and DSH's own resume repair records
 * TOOL_OUTCOME_UNKNOWN, which leaves the question continued for answer().
 * Pending inbox input (a settled child's notice) is durable and stays queued.
 * The caller exits the process right after this reply; nothing may run after.
 */
export async function detachNativeQuestion(server, sessionId) {
  const record = server.roots.get(sessionId);
  const question = server.pendingUserQuestions.get(sessionId);
  if (!record || !question) return { detached: false, reason: 'NO_QUESTION' };
  const agent = record.agent;
  const boundary = detachBoundary(server, agent);
  if (!boundary.detached) return boundary;
  // From here every input is refused; an answer that already won stays won.
  server.detaching = sessionId;
  let result;
  try {
    await server.taskProgress?.flush();
    // A typed answer can already have persisted its request and be awaiting
    // flush. Drain that admitted work instead of leaving an unreplayable request
    // or releasing the Host before the answer's final flush. New input is fenced.
    await Promise.allSettled(question.inputDeliveries ?? []);
    if (
      server.isRootCurrent(record, sessionId) &&
      server.pendingUserQuestions.get(sessionId) !== question
    )
      return { detached: false, reason: 'ANSWERED' };
    // Idle children can also have just persisted a settlement. Flush their
    // sessions through DSH before releasing the process lease.
    for (const active of server.ctx.agents.list())
      await server.ctx.sessions.flush(active.session);
    result = !server.isRootCurrent(record, sessionId)
      ? { detached: false, reason: 'SESSION_CLOSING' }
      : server.pendingUserQuestions.get(sessionId) !== question
        ? { detached: false, reason: 'ANSWERED' }
        : detachBoundary(server, agent);
    return result;
  } finally {
    if (!result?.detached) server.detaching = undefined;
  }
}

/** The root's timed questions as DSH's userQuestions projection reports them. */
export function nativeUserQuestions(server, sessionId) {
  const record = server.roots.get(sessionId);
  if (!record) return { questions: null };
  const state = server.ctx
    .get('sessionProjections')
    ?.stateOf(record.agent.session, 'userQuestions');
  return {
    sequence: record.agent.session.seq,
    questions: (state?.questions.active ?? []).map((item) => ({
      callId: item.callId,
      state: item.state,
      questions: item.questions,
    })),
  };
}

/**
 * Answer a continued question through DSH. The shared AllRice rule runs first:
 * DSH's answer() checks each question once but not the option labels. Returns
 * whether DSH queued the reply; REPLY_QUEUED and BAD_ANSWER keep their codes.
 */
export async function replyNativeQuestion(server, params) {
  const sessionId = params.sessionId;
  const record = await server.ensureRoot(sessionId, { resumeOnly: true });
  server.assertRoot(record, sessionId);
  const question = nativeUserQuestions(server, sessionId).questions?.find(
    (item) => item.state === 'continued' && item.callId === params.callId,
  );
  if (!question) return { queued: false };
  const matched = matchUserQuestionAnswer(
    { questionId: params.callId, questions: question.questions },
    { questionId: params.callId, answers: params.answers },
  );
  if (!matched) throw new TypeError('QUESTION_ANSWER_INVALID');
  try {
    return {
      queued: server.ctx.userQuestions.answer(record.agent, params.callId, {
        answers: matched.answers,
      }),
    };
  } catch (error) {
    // JSON-RPC carries only the message; the Worker routes on DSH's code.
    if (error?.code === 'REPLY_QUEUED' || error?.code === 'BAD_ANSWER')
      throw new Error(error.code);
    throw error;
  }
}
