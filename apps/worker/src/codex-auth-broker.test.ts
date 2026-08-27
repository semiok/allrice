import { describe, expect, it } from 'vitest';

import { parseDshAuthorizationChallenge } from './codex-auth-broker.js';

describe('Codex authorization broker', () => {
  it('extracts only the public device challenge from a DSH notice', () => {
    expect(
      parseDshAuthorizationChallenge({
        method: 'provider.authorization',
        params: {
          url: 'https://auth.openai.com/codex/device',
          code: 'ABCD-EFGH',
        },
      }),
    ).toEqual({
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-EFGH',
    });
  });

  it('does not accept a partial challenge', () => {
    expect(
      parseDshAuthorizationChallenge({
        method: 'provider.authorization',
        params: { url: 'https://auth.openai.com/codex/device', code: null },
      }),
    ).toBeNull();
  });
});
