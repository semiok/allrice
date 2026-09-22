import { describe, expect, it } from 'vitest';
import type { HarnessExecutionResult } from '../adapter.js';
import { randomUUID } from 'node:crypto';
import {
  attachAssistantFailureDiagnostics,
  getAssistantFailureDiagnostics,
} from './assistant-diagnostics.js';
import {
  assertAssistantTaskComplete,
  AssistantExecutionUnresolvedError,
  attachAssistantFailureUsage,
  getAssistantFailureUsage,
} from './assistant-outcome.js';
const result: HarnessExecutionResult = {
  answer: 'Synthetic answer',
  usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 5 },
  provider: 'synthetic',
  model: 'synthetic',
};
describe('assistant completion at the Worker success boundary', () => {
  it('separates missing subscription accounting from an evidenced completion, not from partial work', () => {
    const missing = {
      ...result,
      assistantStatus: 'completed' as const,
      usageComplete: false,
    };
    expect(() => assertAssistantTaskComplete(missing, true)).not.toThrow();
    expect(() => assertAssistantTaskComplete(missing, false)).toThrow();
    expect(() =>
      assertAssistantTaskComplete(
        { ...missing, assistantStatus: 'partial' },
        true,
      ),
    ).toThrow('未完成事项');
    expect(missing.usageComplete).toBe(false);
  });
  it('failure receipts are local, bound to the exact Run/attempt and cannot be forged by serialized fields', () => {
    const error = Object.freeze(Error('original failure'));
    const runId = randomUUID();
    const receipt = {
      usage: { ...result.usage },
      usageComplete: true,
      cacheUsageKnown: false,
    };
    attachAssistantFailureUsage(error, runId, 1, receipt);
    expect(getAssistantFailureUsage(error, runId, 1)).toEqual(receipt);
    expect(getAssistantFailureUsage(error, randomUUID(), 1)).toBeUndefined();
    expect(getAssistantFailureUsage(error, runId, 2)).toBeUndefined();
    expect(
      getAssistantFailureUsage({ ...receipt, runId, attempt: 1 }, runId, 1),
    ).toBeUndefined();
    expect(
      getAssistantFailureUsage(JSON.parse(JSON.stringify(error)), runId, 1),
    ).toBeUndefined();
    receipt.usage.inputTokens = 999;
    expect(getAssistantFailureUsage(error, runId, 1)?.usage.inputTokens).toBe(
      20,
    );
  });
  it.each(['completed', 'partial'] as const)(
    'preserves the safe sidecar from a %s result when usage is incomplete',
    (assistantStatus) => {
      const incomplete = { ...result, assistantStatus, usageComplete: false };
      const diagnostics = {
        version: 1,
        failures: [
          {
            nativeSessionId: randomUUID(),
            callId: randomUUID(),
            phase: 'usage',
            code: 'USAGE_INCOMPLETE',
            stopKind: 'max-tokens',
            inputUsageKnown: true,
            outputUsageKnown: false,
            settlementConfirmed: true,
          },
        ],
        truncated: false,
      };
      attachAssistantFailureDiagnostics(incomplete, diagnostics);
      let error: unknown;
      try {
        assertAssistantTaskComplete(incomplete);
      } catch (failure) {
        error = failure;
      }
      expect(error).toMatchObject({
        code: 'ASSISTANT_EXECUTION_UNRESOLVED',
        retryable: false,
        usageComplete: false,
        usage: result.usage,
      });
      expect(getAssistantFailureDiagnostics(error)).toEqual(diagnostics);
      expect(JSON.stringify(incomplete)).not.toContain('USAGE_INCOMPLETE');
    },
  );
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
