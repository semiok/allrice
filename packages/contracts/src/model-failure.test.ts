import { describe, expect, it } from 'vitest';
import { modelFailure, modelFailureText, publicFailureData } from './model-failure.ts';

describe('synthetic provider failures; historical observations only cover auth/service', () => {
  it.each([
    ['Your authentication token has expired', undefined, 'auth'],
    ['Codex error: Our servers are currently overloaded. Please try again later.', undefined, 'service'],
    ['Account quota exhausted', 429, 'quota'],
    ['Too many requests', 429, 'rate_limit'],
    ['Connection reset by peer', undefined, 'transport'],
    ['Maximum context length exceeded', undefined, 'context'],
    ['Unrecognized provider failure', undefined, 'unknown'],
  ] as const)('classifies explicit facts: %s', (message, status, category) => {
    expect(modelFailure(message, status).category).toBe(category);
    expect(modelFailureText(category, 'run-reference')).toMatch(/管理员|稍后|拆小/);
  });

  it('removes each sensitive form, bounds output and fails closed for invalid input', () => {
    const secrets = [
      'https://private.test/path?q=secret', 'help.private.test', 'Bearer short-secret',
      'sk-private', 'eyJhbGci.eyJzdWI.signature', 'person@example.test',
      '/Users/private/file.txt', '~/private/file', '../private/file', './private/file',
      'C:\\Users\\private\\file.txt', '\\\\server\\share\\file',
      '12345678-1234-4123-8123-123456789abc', 'req_private', 'request_id=opaque',
      'api_key=private-value',
    ];
    for (const secret of secrets) {
      const failure = modelFailure(`Your authentication token has expired ${secret}`);
      expect(failure.category).toBe('auth');
      expect(failure.upstreamMessage).not.toContain(secret);
    }
    expect(modelFailure('a'.repeat(5000)).upstreamMessage.length).toBeLessThanOrEqual(1000);
    for (const invalid of [null, {}, Symbol('private')])
      expect(modelFailure(invalid).upstreamMessage).toBe('原文无法安全展示');
    const hostile = new Proxy({}, { get() { throw Error('private'); } });
    expect(modelFailure(hostile).upstreamMessage).toBe('原文无法安全展示');
  });

  it('never serializes upstream text through arbitrary nested projection metadata', () => {
    const data = publicFailureData({ id: 'run-reference', metadata: [{
      modelFailure: { category: 'auth', upstreamMessage: 'PRIVATE', nested: { raw: 'PRIVATE' } },
      error: { code: 'DSH_PI_AI_ERROR', message: 'Your authentication token has expired' },
      errorMessage: 'Your authentication token has expired',
    }] });
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE|authentication token has expired|upstreamMessage/);
    expect(JSON.stringify(data)).toContain('管理员');
  });
});
