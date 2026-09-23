/* Native DSH middleware only; no Agent loop, extra model or action authority. */
import { createHash, randomUUID } from 'node:crypto';

// Strip transport/log noise only. Business dates, paths and query text remain.
const noise = new Set([
  'timestamp',
  'updatedAt',
  'elapsedMs',
  'durationMs',
  'requestId',
  'traceId',
  'nonce',
]);
export function stableProgressValue(value, depth = 0) {
  if (depth > 20) return '[depth]';
  if (typeof value === 'string')
    return value
      .replace(
        /^(?:\[\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\]|\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s*/gm,
        '[log-time] ',
      )
      .replace(
        /\b(elapsed|duration)[:=]\s*\d+(?:\.\d+)?\s*(?:ms|s)\b/gi,
        '$1=[time]',
      );
  if (Array.isArray(value))
    return value.map((v) => stableProgressValue(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => !noise.has(k))
        .map((k) => [k, stableProgressValue(value[k], depth + 1)]),
    );
  return value;
}
export const progressDigest = (value) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(stableProgressValue(value)) ?? 'null')
    .digest('hex')}`;

export function progressResult(name, block) {
  const raw = block?.output ?? block?.content ?? block?.result ?? null;
  const content =
    Array.isArray(raw) && raw.every((b) => b?.type === 'text')
      ? raw.map((b) => b.text).join('\n')
      : raw;
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  let value = content;
  if (typeof content === 'string') {
    try {
      value = JSON.parse(content);
    } catch {
      /* Plain text remains evidence. */
    }
  }
  const code = value?.error?.code ?? value?.code;
  const retry =
    block?.isError === true &&
    ['RATE_LIMIT', 'QUOTA', '429', '503', 'TIMEOUT', 'ETIMEDOUT'].includes(
      String(code),
    );
  const control = [
    'todo_write',
    'ask_user_question',
    'skill',
    'assistant_delegate',
    'assistant_message',
    'assistant_report',
  ].includes(name);
  // Only semantically explicit status operations, not arbitrary empty tools.
  const poll = [
    'assistant_list',
    'assistant_inspect',
    'assistant_status',
  ].includes(name);
  return {
    outcome: retry
      ? 'retry'
      : control
        ? 'control'
        : poll
          ? 'poll'
          : block?.isError === true
            ? 'error'
            : !text || text === 'null' || text === '[]' || text === '{}'
              ? 'empty'
              : 'success',
    resultDigest: progressDigest(value),
  };
}

export function installTaskProgress(ctx, bridge) {
  let writes = Promise.resolve(),
    failure;
  const toolNames = new Map(); // outstanding calls only; cleared at receipt
  let prompting;
  function rootFor(agent) {
    for (let depth = 0; depth < 32; depth++) {
      if (ctx.agents.roots().includes(agent)) return agent;
      agent = ctx.agents.get(agent?.session?.header?.parentSession);
      if (!agent) break;
    }
    throw Error('task_progress_root_not_live');
  }
  function track(request) {
    writes = writes
      .then(() => bridge(request))
      .catch((error) => {
        failure = error;
      });
  }
  async function flush() {
    await writes;
    if (failure) throw failure;
  }
  async function check(agent, signal) {
    await flush();
    const status = await bridge(
      { action: 'check', nativeSessionId: agent.id },
      signal,
    );
    if (!status.paused) return;
    if (!prompting) {
      const root = rootFor(agent);
      prompting = (async () => {
        const answer = await ctx.userQuestions.ask({
          agent: root,
          signal,
          questions: [
            {
              id: 'runtime-progress',
              header: '需要确认',
              question:
                '近期操作反复失败或没有新结果，Rice 已暂停新调用。是否调整后继续？',
              detail: `原因：${status.reason === 'repeated_failure' ? '重复失败' : '重复无进展'}。最近操作：${(status.recent ?? []).map((f) => `${f.tool}（${f.outcome}）`).join('、')}。已有内容、工件和用量记录会保留；继续不代表批准文件修改或其他操作。`,
              options: [
                {
                  label: '重新检查后继续',
                  description: '保留统计，重新检查当前权限和任务状态。',
                },
                {
                  label: '取消任务',
                  description: '停止后续调用，保留已有交付物。',
                },
              ],
            },
          ],
        });
        const chosen = answer.answers.find((a) => a.id === 'runtime-progress');
        const cancel = chosen?.selected?.includes('取消任务');
        if (
          !cancel &&
          !chosen?.selected?.includes('重新检查后继续') &&
          !chosen?.custom?.trim()
        )
          throw Error('task_progress_answer_required');
        await bridge(
          {
            action: 'decide',
            nativeSessionId: root.id,
            pauseId: status.pauseId,
            decision: cancel ? 'cancel' : 'continue',
          },
          signal,
        );
        if (cancel) throw Error('task_progress_canceled');
        if (chosen?.custom?.trim())
          root.steer({
            role: 'user',
            content: [{ type: 'text', text: chosen.custom }],
          });
      })().finally(() => {
        prompting = undefined;
      });
    }
    await prompting;
    // A sibling might have produced a new pause; recheck at dispatch below.
  }
  ctx.on('session/event', (session, event) => {
    const d = event.data;
    if (event.type === 'tool/call') {
      let args = d.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          /* Hash exact invalid payload. */
        }
      }
      const key = `${session.id}:${d.callId}`;
      if (toolNames.size >= 1024 && !toolNames.has(key))
        throw Error('task_progress_inflight_overload');
      toolNames.set(key, d.name);
      track({
        action: 'start',
        kind: 'tool',
        nativeSessionId: session.id,
        callId: d.callId,
        name: d.name,
        argumentsDigest: progressDigest(args),
      });
    } else if (event.type === 'tool/result') {
      const b = d.message?.content?.find((b) => b.type === 'tool-result');
      const callId =
        b?.toolCallId ?? d.message?.toolCallId ?? d.message?.callId;
      if (!callId) return;
      const key = `${session.id}:${callId}`,
        name = toolNames.get(key) ?? 'unknown';
      toolNames.delete(key);
      track({
        action: 'finish',
        kind: 'tool',
        nativeSessionId: session.id,
        callId,
        ...progressResult(name, b),
      });
    }
  });
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    // Check before admission/dispatch, not after losing a completed answer.
    await check(agent, signal);
    return next();
  });
  ctx.on('llm/stream', async function* (options, next) {
    const agent = ctx.agents.get(options.sessionId);
    if (!agent) {
      yield* next();
      return;
    }
    await check(agent, options.signal);
    const callId = randomUUID();
    await bridge(
      { action: 'start', kind: 'model', nativeSessionId: agent.id, callId },
      options.signal,
    );
    let completed = false;
    try {
      yield* next();
      completed = true;
    } finally {
      // This is a local request completion receipt, NOT a fabricated Token
      // receipt or proof of provider billing. Provider usage stays separate.
      await bridge({
        action: 'finish',
        kind: 'model',
        nativeSessionId: agent.id,
        callId,
        outcome: completed ? 'success' : 'error',
        resultDigest: progressDigest({ completed }),
      });
    }
  });
  return { flush };
}
