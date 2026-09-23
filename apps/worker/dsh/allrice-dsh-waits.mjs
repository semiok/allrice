/** Persist only quiescent user-question boundaries. This does not serialize a
 * JavaScript continuation or restart the original task prompt. */
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session';
import { structuredUserQuestionAnswer } from './allrice-dsh-runtime-compatibility.mjs';
import { deliverDshInput } from './allrice-dsh-inputs.mjs';

for (const type of ['allrice/wait/checkpoint', 'allrice/wait/continued'])
  KNOWN_SESSION_EVENT_TYPES.add(type);

export function pendingNativeWait(agent) {
  const checkpoint = agent.session.events.findLast(
    (e) => e.type === 'allrice/wait/checkpoint',
  );
  if (!checkpoint) return null;
  if (
    agent.session.events.some(
      (e) => e.seq > checkpoint.seq && e.type === 'allrice/wait/continued',
    )
  )
    return null;
  return { ...checkpoint.data, sequence: checkpoint.seq };
}

export async function checkpointNativeQuestion(server, sessionId, questionId) {
  const record = server.sessions.get(sessionId);
  const question = server.pendingUserQuestions.get(sessionId);
  if (!record || !question || question.questionId !== questionId) return null;
  const agent = record.handle.agent;
  // Another agent/tool may still be doing real work. Never interrupt it just
  // because the root is asking a question.
  if (server.ctx.agents.list().some((a) => a !== agent)) return null;
  const open = new Map();
  for (const e of agent.session.events) {
    if (e.type === 'tool/call') open.set(e.data.callId, e.data.name);
    if (e.type === 'tool/result') {
      const b = e.data.message?.content?.find((b) => b.type === 'tool-result');
      open.delete(
        b?.toolCallId ?? e.data.message?.toolCallId ?? e.data.message?.callId,
      );
    }
  }
  if (
    open.size > 1 ||
    [...open.values()].some((name) => name !== 'ask_user_question')
  )
    return null;
  await server.taskProgress?.flush();
  // A user answer can race the preceding flush.
  if (server.pendingUserQuestions.get(sessionId) !== question) return null;
  const turn = agent.session.events.findLast((e) => e.type === 'turn/start')
    ?.data.turn;
  if (turn === undefined) return null;
  const data = {
    sessionId,
    questionId,
    turnId: `${sessionId}:turn:${turn}`,
    questions: question.questions,
  };
  agent.session.append('allrice/wait/checkpoint', data);
  await server.ctx.sessions.flush(agent.session);
  // No await between the final identity check and cancel. The only interrupted
  // callback is this non-executing question; its answer is stored on recovery.
  if (server.pendingUserQuestions.get(sessionId) !== question) return null;
  agent.cancel({ kind: 'user' }, { keepInbox: true });
  await agent.whenIdle();
  await server.taskProgress?.flush();
  await server.ctx.sessions.flush(agent.session);
  return pendingNativeWait(agent);
}

export async function answerNativeWait(server, params) {
  const record = await server.getOrCreateSession(params.sessionId);
  const agent = record.handle.agent;
  const wait = pendingNativeWait(agent);
  if (
    !wait ||
    agent.status !== 'idle' ||
    wait.questionId !== params.questionId ||
    wait.turnId !== params.turnId
  )
    throw Error('NATIVE_WAIT_CHANGED');
  const answer = structuredUserQuestionAnswer(wait, params.text);
  if (!answer) throw Error('QUESTION_ANSWER_REQUIRED');
  // Use the existing persisted typed-input proof and digest. It resolves this
  // checkpoint, without dispatching a model or treating an answer as approval.
  let resolved;
  const proof = await deliverDshInput(
    {
      agent,
      sessionId: params.sessionId,
      pendingQuestion: {
        ...wait,
        resolve: (value) => {
          resolved = value;
        },
      },
      isCurrent: () =>
        pendingNativeWait(agent)?.questionId === wait.questionId &&
        agent.status === 'idle',
      flush: () => server.ctx.sessions.flush(agent.session),
      notify: () =>
        server.userQuestionNotify({
          sessionId: params.sessionId,
          questionId: wait.questionId,
          answered: true,
        }),
      suspended: true,
    },
    { ...params, kind: 'ask_user' },
  );
  if (proof.status !== 'adopted') throw Error('INPUT_OUTCOME_UNKNOWN');
  return {
    proof,
    // A new native turn continues its persisted conversation, never the task's
    // original prompt. No pending side-effect callback is reconstructed.
    prompt: `Continue the existing task after this persisted user question. Prior completed operations remain completed. This answer is not action approval.\nQuestion: ${JSON.stringify(wait.questions)}\nAnswer: ${JSON.stringify(resolved ?? answer)}`,
  };
}

export async function continueNativeWait(server, params) {
  const record = await server.getOrCreateSession(params.sessionId);
  const agent = record.handle.agent;
  const wait = pendingNativeWait(agent);
  if (!wait || wait.questionId !== params.questionId || agent.status !== 'idle')
    throw Error('NATIVE_WAIT_CHANGED');
  const answered = await answerNativeWait(server, params);
  if (wait.questions.some((q) => q.id === 'runtime-progress')) {
    if (!server.progressBridge) throw Error('task_progress_disabled');
    const status = await server.progressBridge({
      action: 'check',
      nativeSessionId: params.sessionId,
    });
    if (!status.paused) throw Error('task_progress_stale_pause');
    const chosen = structuredUserQuestionAnswer(wait, params.text).answers.find(
      (a) => a.id === 'runtime-progress',
    );
    const cancel = chosen?.selected?.includes('取消任务');
    if (
      !cancel &&
      !chosen?.selected?.includes('重新检查后继续') &&
      !chosen?.custom?.trim()
    )
      throw Error('task_progress_answer_required');
    await server.progressBridge({
      action: 'decide',
      nativeSessionId: params.sessionId,
      pauseId: status.pauseId,
      decision: cancel ? 'cancel' : 'continue',
    });
    if (cancel) throw Error('task_progress_canceled');
  }
  // Persist dispatch intent first. Losing its ACK is outcome unknown; a later
  // Worker must not resend this continuation and execute its tools twice.
  agent.session.append('allrice/wait/continued', {
    questionId: wait.questionId,
    inputId: params.inputId,
  });
  await server.ctx.sessions.flush(agent.session);
  return server.prompt({
    sessionId: params.sessionId,
    contentBlocks: [{ type: 'text', text: answered.prompt }],
  });
}
