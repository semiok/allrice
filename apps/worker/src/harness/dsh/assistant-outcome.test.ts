import { describe, expect, it } from 'vitest';
import type { HarnessExecutionResult } from '../adapter.js';
import {
  assertAssistantTaskComplete,
  AssistantExecutionUnresolvedError,
} from './assistant-outcome.js';
const result: HarnessExecutionResult = {
  answer: 'Synthetic answer',
  usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 5 },
  provider: 'synthetic',
  model: 'synthetic',
};
describe('assistant completion at the Worker success boundary', () => {
  it('keeps the legacy non-assistant path unchanged', () => {
    expect(() => assertAssistantTaskComplete(result)).not.toThrow();
  });
  it('accepts only an explicitly complete assistant outcome with settled usage', () => {
    expect(() =>
      assertAssistantTaskComplete({
        ...result,
        assistantStatus: 'completed',
        usageComplete: true,
      }),
    ).not.toThrow();
  });
  it('does not convert a saved partial answer into a successful task or retry', () => {
    expect(() =>
      assertAssistantTaskComplete({
        ...result,
        assistantStatus: 'partial',
        usageComplete: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'ASSISTANT_PARTIAL_RESULT',
        retryable: false,
      }),
    );
  });
  it('preserves confirmed usage when unresolved accounting blocks completion', () => {
    expect(() =>
      assertAssistantTaskComplete({
        ...result,
        assistantStatus: 'completed',
        usageComplete: false,
      }),
    ).toThrow(AssistantExecutionUnresolvedError);
    const error = new AssistantExecutionUnresolvedError(result.usage);
    expect(error).toMatchObject({
      code: 'ASSISTANT_EXECUTION_UNRESOLVED',
      retryable: false,
      usage: result.usage,
      usageComplete: false,
    });
  });
});
