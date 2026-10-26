import { describe, expect, it, vi } from 'vitest';

import { ApiErrorSchema, LoginInputSchema } from '@allrice/contracts';
import { IdentityError } from '@allrice/database';

import { identityErrorResponse } from './responses';

describe('identity error responses', () => {
  it.each([
    ['authentication_failed', 401, 'AUTHENTICATION_REQUIRED'],
    ['authorization_denied', 403, 'AUTHORIZATION_DENIED'],
    ['portal_account_mismatch', 403, 'AUTHORIZATION_DENIED'],
    ['tenant_context_invalid', 403, 'AUTHORIZATION_DENIED'],
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
      LoginInputSchema.safeParse({ username: '张', password: 'x' }).error,
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

  it('reports an unclassified failure as a retryable outage, not bad input', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = identityErrorResponse(
        new Error('connect ECONNREFUSED 127.0.0.1:5432'),
      );
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({
        error: { code: 'DEPENDENCY_UNAVAILABLE', retryable: true },
      });
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
});
