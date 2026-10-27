import { matchUserQuestionAnswer } from '@allrice/contracts/native-runtime';

// MET-210 timed questions. AllRice is only the lease here: the question's state
// stays DSH's own userQuestions projection, and a late answer is DSH's answer().

/** Tool calls of the root's journal that have no recorded result yet. */
function openToolCalls(agent) {
  const open = new Map();
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'tool/call')
      open.set(event.data.callId, event.data.name);
    if (event.type === 'tool/result') {
      const message = event.data.message;
      open.delete(message?.toolCallId ?? message?.callId);
    }
  }
  return open;
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
  // A running child still does real work; its result must not become unknown.
  if (
    server.ctx.agents.list().some((a) => a !== agent && a.status === 'running')
  )
    return { detached: false, reason: 'AGENTS_RUNNING' };
  const open = openToolCalls(agent);
  const [callId, name] = open.size === 1 ? [...open][0] : [];
  if (name !== 'ask_user_question')
    return { detached: false, reason: 'TOOL_CALLS_OPEN' };
  // From here every input is refused; an answer that already won stays won.
  server.detaching = sessionId;
  await server.taskProgress?.flush();
  await server.ctx.sessions.flush(agent.session);
  if (
    !server.isRootCurrent(record, sessionId) ||
    server.pendingUserQuestions.get(sessionId) !== question
  ) {
    server.detaching = undefined;
    return { detached: false, reason: 'ANSWERED' };
  }
  return { detached: true, callId, questionId: question.questionId };
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
  const question = server.ctx.userQuestions
    .continued(record.agent)
    .find((item) => item.callId === params.callId);
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
