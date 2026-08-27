import { describe, expect, it } from 'vitest';

import { IdentityError } from '@allrice/database';

import { executionErrorResponse } from './responses';

describe('execution error responses', () => {
  it('returns 403 when tenant selection is outside the actor membership', async () => {
    const response = executionErrorResponse(
      new IdentityError('tenant_context_invalid'),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTHORIZATION_DENIED', retryable: false },
    });
  });

  it('returns 401 when session authentication fails', async () => {
    const response = executionErrorResponse(
      new IdentityError('authentication_failed'),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED', retryable: false },
    });
  });
});
