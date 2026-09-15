import { describe, expect, it } from 'vitest';

import {
  codexQuotaObservation,
  parseDshAuthorizationChallenge,
} from './codex-auth-broker.js';

describe('Codex authorization broker', () => {
  it.each([undefined, null, {}, { accessToken: 'must-not-escape' }])(
    'quota transport/schema error must not become an account clear: %j',
    (value) => {
      const result = codexQuotaObservation(value, true);
      expect(result).toMatchObject({
        status: 'error',
        accountFingerprint: null,
        detailCode: 'codex_quota_protocol_unavailable',
        buckets: [],
      });
      expect(result).not.toBeNull();
      expect(JSON.stringify(result)).not.toContain('must-not-escape');
    },
  );
  it('clears allowance only when credential status explicitly disconnects', () => {
    expect(codexQuotaObservation({}, false)).toBeNull();
  });
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
