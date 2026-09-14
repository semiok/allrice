import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  attachAssistantFailureDiagnostics,
  getAssistantFailureDiagnostics,
  parseAssistantFailureDiagnostics,
} from './assistant-diagnostics.js';
import { AssistantExecutionUnresolvedError } from './assistant-outcome.js';

function evidence() {
  return {
    version: 1,
    failures: [
      {
        nativeSessionId: randomUUID(),
        callId: randomUUID(),
        phase: 'finish',
        code: 'SERVER',
        stopKind: 'error',
        inputUsageKnown: false,
        outputUsageKnown: false,
        settlementConfirmed: true,
      },
    ],
    truncated: false,
  };
}
describe('closed-schema assistant failure diagnostics', () => {
  it('retains only detached scalar observations with explicit unknown usage', () => {
    const input = evidence();
    const parsed = parseAssistantFailureDiagnostics(input);
    expect(parsed).toEqual(input);
    input.failures[0]!.code = 'changed';
    expect(parsed!.failures[0]!.code).toBe('SERVER');
  });
  it.each([
    { message: 'synthetic-secret' },
    { status: 503 },
    { cause: { token: 'synthetic-secret' } },
    { code: 'UNKNOWN_SYNTHETIC_SECRET' },
    { stopKind: 'error:https://synthetic-secret' },
    { phase: 'raw_response' },
    { callId: 'synthetic-secret' },
    { nativeSessionId: 'https://synthetic-secret' },
    { inputUsageKnown: 'false' },
    { settlementFailureCode: 'secret' },
  ])(
    'rejects extra or unvalidated fields rather than echoing them: %j',
    (extra) => {
      const input = evidence();
      Object.assign(input.failures[0]!, extra);
      expect(parseAssistantFailureDiagnostics(input)).toBeUndefined();
    },
  );
  it('rejects root extras, duplicate calls, and more than 64 records', () => {
    expect(
      parseAssistantFailureDiagnostics({ ...evidence(), raw: 'secret' }),
    ).toBeUndefined();
    const duplicated = evidence();
    duplicated.failures.push({ ...duplicated.failures[0]! });
    expect(parseAssistantFailureDiagnostics(duplicated)).toBeUndefined();
    const many = evidence();
    many.failures = Array.from({ length: 65 }, () => evidence().failures[0]!);
    expect(parseAssistantFailureDiagnostics(many)).toBeUndefined();
    many.failures.pop();
    expect(parseAssistantFailureDiagnostics(many)).toEqual(many);
  });
  it('does not execute accessors, proxy traps or toJSON while sanitizing', () => {
    const trap = vi.fn(() => {
      throw Error('must_not_execute');
    });
    const accessor = evidence();
    Object.defineProperty(accessor.failures[0]!, 'code', { get: trap });
    expect(parseAssistantFailureDiagnostics(accessor)).toBeUndefined();
    expect(
      parseAssistantFailureDiagnostics(new Proxy(evidence(), { get: trap })),
    ).toBeUndefined();
    expect(
      parseAssistantFailureDiagnostics({ ...evidence(), toJSON: trap }),
    ).toBeUndefined();
    expect(trap).not.toHaveBeenCalled();
  });
  it('keeps frozen original errors and their retryability unchanged', () => {
    const error = Object.freeze(
      Object.assign(Error('not-copied'), {
        code: 'ORIGINAL',
        retryable: false,
      }),
    );
    attachAssistantFailureDiagnostics(error, evidence());
    expect(getAssistantFailureDiagnostics(error)?.failures[0]!.code).toBe(
      'SERVER',
    );
    expect(error).toMatchObject({ code: 'ORIGINAL', retryable: false });
    expect(error).not.toHaveProperty('cause');
    expect(error).not.toHaveProperty('diagnostics');
    const firstRead = getAssistantFailureDiagnostics(error)!;
    firstRead.failures[0]!.code = 'UNKNOWN';
    expect(getAssistantFailureDiagnostics(error)!.failures[0]!.code).toBe(
      'SERVER',
    );
  });
  it('does not trust a lookalike error property or expose arbitrary cause payloads', () => {
    const fake = { diagnostics: evidence(), cause: { token: 'secret' } };
    expect(getAssistantFailureDiagnostics(fake)).toBeUndefined();
    const error = new AssistantExecutionUnresolvedError(
      { inputTokens: 20, cachedInputTokens: 0, outputTokens: 5 },
      false,
      evidence(),
    );
    expect(error).toMatchObject({
      code: 'ASSISTANT_EXECUTION_UNRESOLVED',
      retryable: false,
      usageComplete: false,
    });
    expect(getAssistantFailureDiagnostics(error)?.failures).toHaveLength(1);
  });
});
