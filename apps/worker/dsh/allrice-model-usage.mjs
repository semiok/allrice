// Text/reasoning framing alone is not output. Keep tool identities, full end
// blocks and malformed/unknown content conservative, even without deltas.
export function hasModelOutput(chunk) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
    return typeof chunk.text !== 'string' || chunk.text.length > 0;
  if (chunk.type === 'tool-call-delta') return true;
  if (chunk.type === 'block-start')
    return !['text', 'reasoning'].includes(chunk.blockType);
  if (chunk.type === 'block-end') {
    const block = chunk.block;
    return ['text', 'reasoning'].includes(block?.type)
      ? typeof block.text !== 'string' || block.text.length > 0
      : true;
  }
  return false;
}

/** Pinned TokenUsage has disjoint uncached/read-cache/write-cache counts.
 * Invalid or absent required usage keeps that dimension's reservation. */
export function settledTokenUsage(usage, observedOutput = false) {
  const valid = (value) => Number.isSafeInteger(value) && value >= 0;
  const inputs = [
    usage.inputTokens,
    usage.cacheReadTokens === undefined ? 0 : usage.cacheReadTokens,
    usage.cacheWriteTokens === undefined ? 0 : usage.cacheWriteTokens,
  ];
  const inputTokens = inputs.reduce((sum, value) => sum + value, 0);
  return {
    // The pinned provider adapter synthesizes all-zero usage when the remote
    // omits usage. A nonempty admitted model prompt cannot cost zero input.
    ...(inputs.every(valid) && valid(inputTokens) && inputTokens > 0
      ? { inputTokens }
      : {}),
    ...(valid(usage.outputTokens) &&
    !(observedOutput && usage.outputTokens === 0) &&
    !(inputTokens === 0 && usage.outputTokens === 0)
      ? { outputTokens: usage.outputTokens }
      : {}),
  };
}
