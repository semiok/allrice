import { describe, expect, it } from 'vitest';

import { estimateModelCostCents, readModelPricing } from './model-cost.js';

describe('model cost metering', () => {
  it('prices only non-cached input and output tokens', () => {
    const pricing = readModelPricing(
      JSON.stringify({
        'openai-compatible:MiniMax-M3': {
          inputCentsPerMillion: 100,
          outputCentsPerMillion: 400,
        },
      }),
    );
    expect(
      estimateModelCostCents({
        provider: 'openai-compatible',
        model: 'MiniMax-M3',
        inputTokens: 12_000,
        cachedInputTokens: 2_000,
        outputTokens: 5_000,
        pricing,
      }),
    ).toBe(3);
  });

  it('is explicitly zero when the platform has not configured a price', () => {
    expect(
      estimateModelCostCents({
        provider: 'codex',
        model: 'gpt-5.6-luna',
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 500,
        pricing: {},
      }),
    ).toBe(0);
  });
});
