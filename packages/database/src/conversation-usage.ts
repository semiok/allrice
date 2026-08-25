export function conversationUsageWatermark(input: {
  baselineInputTokens: number | null;
  inputTokens: number;
}) {
  const baselineInputTokens = input.baselineInputTokens ?? input.inputTokens;
  return {
    baselineInputTokens,
    inputTokens: input.inputTokens,
    dynamicContextTokens: Math.max(0, input.inputTokens - baselineInputTokens),
  };
}

export function effectiveContextTokens(input: {
  applicationEstimatedTokens: number;
  observedDynamicTokens: number;
}) {
  return Math.max(
    input.applicationEstimatedTokens,
    input.observedDynamicTokens,
  );
}
