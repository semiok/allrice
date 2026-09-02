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

export const defaultContextCompactThreshold = 40_000;

export function sessionCompactionStatus(input: {
  pressureTokens: number;
  thresholdTokens: number;
}) {
  const pressureTokens = Math.max(0, Math.floor(input.pressureTokens));
  const thresholdTokens = Math.max(1, Math.floor(input.thresholdTokens));
  return {
    pressureTokens,
    thresholdTokens,
    remainingTokens: Math.max(0, thresholdTokens - pressureTokens),
    percentage: Math.min(
      100,
      Math.floor((pressureTokens / thresholdTokens) * 100),
    ),
    compactionDue: pressureTokens >= thresholdTokens,
  };
}
