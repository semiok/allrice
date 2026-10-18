// AllRice compatibility at the public llm/stream seam. The pinned pi-ai
// transport flattens structured provider errors into text; DSH then reports
// this explicit overload receipt as PI_AI_ERROR. Do not broaden all generic
// errors, infer missing HTTP statuses, or introduce another retry loop.
const codexOverloadMessage =
  'Codex error: Our servers are currently overloaded. Please try again later.';

export function normalizeModelFailure(chunk, options) {
  if (
    options.provider !== 'openai-codex' ||
    options.signal?.aborted ||
    chunk.type !== 'finish' ||
    chunk.reason?.kind !== 'error' ||
    chunk.reason.failure?.code !== 'PI_AI_ERROR'
  )
    return chunk;
  const message = chunk.reason.failure.message;
  const code =
    message === codexOverloadMessage
      ? 'SERVER'
      : typeof message === 'string' &&
          (/^WebSocket closed 1006(?:\s|$)/i.test(message) ||
            /^WebSocket closed 1000$/i.test(message))
        ? 'TRANSPORT'
        : null;
  if (!code) return chunk;
  return {
    ...chunk,
    reason: {
      ...chunk.reason,
      failure: { ...chunk.reason.failure, code },
    },
  };
}

// Install after accounting/progress observers so they see the same normalized
// receipt as the native loop. Their settlement and cancellation gates still
// run before DSH's existing bounded agent/request-error recovery.
export function installModelErrorNormalization(ctx) {
  return ctx.on('llm/stream', async function* (options, next) {
    for await (const chunk of next())
      yield normalizeModelFailure(chunk, options);
  });
}
