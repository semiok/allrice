/* global process */
/** DSH folds its own journal. This adapter only publishes the public view. */
export function publishNativeQuestions(ctx, session, notify) {
  if (process.env.ALLRICE_ASK_USER_MODE !== 'timed') return;
  const projection = ctx
    .get('sessionProjections')
    ?.stateOf(session, 'userQuestions');
  if (!projection) throw Error('NATIVE_QUESTION_PROJECTION_UNAVAILABLE');
  notify('session.user-questions', {
    sessionId: String(session.id),
    sequence: session.seq,
    questions: projection.questions,
  });
}

export const questionProjectionBoundaries = new Set([
  'tool/call',
  'tool/result',
  'tool/ptc-dispatch',
  'user/message',
]);
