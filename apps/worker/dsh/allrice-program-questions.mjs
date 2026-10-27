import { Config } from '@deepseek-ai/dsh-tool-ask-user';
/* global process */

// Worker freezes the owner's preference and supplies its own idle-close value.
// Program questions have no durable DSH projection: forever uses the release
// point as a timed wait; disabling release preserves the blocking ask.
export function askProgramQuestion(userQuestions, request, callId) {
  // 子智能体方案 PR4a/b/c 删除旧助手包装层时，一并删掉这个分支。
  if (
    process.env.ALLRICE_ASSISTANTS_ENABLED === '1' ||
    process.env.ALLRICE_MAINTENANCE_OUTPUT_TOKENS
  )
    return userQuestions.ask(request);
  const releaseMs = Number(process.env.ALLRICE_QUESTION_RELEASE_MS ?? 0);
  if (releaseMs === 0) return userQuestions.ask(request);
  const seconds = Config(
    process.env.ALLRICE_ASK_USER_TIMEOUT === undefined
      ? {}
      : { timeout: Number(process.env.ALLRICE_ASK_USER_TIMEOUT) },
  ).timeout;
  return userQuestions.askTimed(
    request,
    callId,
    seconds === -1 ? releaseMs : seconds * 1000,
  );
}
