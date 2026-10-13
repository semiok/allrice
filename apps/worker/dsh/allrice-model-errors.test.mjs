/* global AbortController */
import { describe, expect, it } from 'vitest';
import { normalizeModelFailure } from './allrice-model-errors.mjs';

const message =
  'Codex error: Our servers are currently overloaded. Please try again later.';
const options = { provider: 'openai-codex' };
const finish = (failure = {}) => ({
  type: 'finish',
  reason: {
    kind: 'error',
    failure: { code: 'PI_AI_ERROR', message, ...failure },
  },
});

describe('AllRice model failure compatibility', () => {
  it('classifies only the exact Codex overload receipt, retaining the message and original chunk', () => {
    const original = finish();
    const mapped = normalizeModelFailure(original, options);
    expect(mapped.reason.failure).toEqual({ code: 'SERVER', message });
    expect(original.reason.failure.code).toBe('PI_AI_ERROR');
    expect(mapped.reason.failure).not.toHaveProperty('httpStatus');
  });

  it.each([
    'Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists.',
    'Codex error: unknown failure',
    'Our servers are currently overloaded. Please try again later.',
    `${message} Invalid request.`,
    `Request rejected: ${message}`,
    '',
  ])(
    'does not guess whether an unrecognized message is transient: %s',
    (message) => {
      const chunk = finish({ message });
      expect(normalizeModelFailure(chunk, options)).toBe(chunk);
    },
  );

  it.each([
    'AUTH',
    'QUOTA',
    'INVALID_REQUEST',
    'ABORTED',
    'TRANSPORT',
    'SERVER',
  ])('preserves an existing native %s classification', (code) => {
    const chunk = finish({ code });
    expect(normalizeModelFailure(chunk, options)).toBe(chunk);
  });

  it('preserves cancellation, other providers, content and successful finishes', () => {
    const controller = new AbortController();
    controller.abort();
    const chunk = finish();
    expect(
      normalizeModelFailure(chunk, { ...options, signal: controller.signal }),
    ).toBe(chunk);
    expect(
      normalizeModelFailure(chunk, { provider: 'openai-compatible' }),
    ).toBe(chunk);
    for (const chunk of [
      { type: 'text-delta', text: message },
      { type: 'finish', reason: { kind: 'stop' } },
      { ...finish(), reason: { ...finish().reason, kind: 'aborted' } },
    ])
      expect(normalizeModelFailure(chunk, options)).toBe(chunk);
  });
});
