import { describe, expect, it } from 'vitest';

import { ApiErrorSchema } from '@allrice/contracts';
import { IdentityError } from '@allrice/database';

import { identityErrorResponse } from './responses';

describe('identity error responses', () => {
  it.each([
    ['authentication_failed', 401, 'AUTHENTICATION_REQUIRED'],
    ['authorization_denied', 403, 'AUTHORIZATION_DENIED'],
    ['tenant_context_invalid', 403, 'AUTHORIZATION_DENIED'],
    ['invitation_invalid', 400, 'VALIDATION_FAILED'],
  ] as const)(
    'maps %s to a canonical problem',
    async (source, status, code) => {
      const response = identityErrorResponse(new IdentityError(source));
      const body = await response.json();

      expect(response.status).toBe(status);
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({ error: { code, retryable: false } });
    },
  );

  it('preserves validation status while returning the canonical envelope', async () => {
    for (const error of [
      new SyntaxError('bad json'),
      new Error('unclassified identity failure'),
    ]) {
      const response = identityErrorResponse(error);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        error: { code: 'VALIDATION_FAILED', retryable: false },
      });
    }
  });
});
