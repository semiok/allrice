import { describe, expect, it } from 'vitest';

import { ApiErrorSchema } from '@allrice/contracts';

import {
  apiErrorResponse,
  apiProblem,
  authenticationRequiredProblem,
  authorizationDeniedProblem,
  isRequestValidationError,
} from './api-error-response';

describe('apiProblem', () => {
  it('returns the canonical error envelope', async () => {
    const response = apiProblem({
      status: 409,
      code: 'CONFLICT',
      message: 'State changed',
      requestId: '3b2a6bb2-d603-487f-96fd-c3f26a911a37',
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'CONFLICT',
        message: 'State changed',
        requestId: '3b2a6bb2-d603-487f-96fd-c3f26a911a37',
        retryable: false,
      },
    });
  });

  it('defaults server failures to retryable', async () => {
    const response = apiProblem({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'Try again later',
    });
    const body = (await response.json()) as {
      error: { requestId: string; retryable: boolean };
    };

    expect(body.error.retryable).toBe(true);
    expect(body.error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(ApiErrorSchema.safeParse(body).success).toBe(true);
  });

  it('returns canonical authentication and authorization problems', async () => {
    for (const [response, status, code] of [
      [authenticationRequiredProblem(), 401, 'AUTHENTICATION_REQUIRED'],
      [authorizationDeniedProblem(), 403, 'AUTHORIZATION_DENIED'],
    ] as const) {
      expect(response.status).toBe(status);
      const body = await response.json();
      expect(ApiErrorSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({ error: { code, retryable: false } });
    }
  });

  it('keeps malformed JSON and schema errors in the validation envelope', async () => {
    const malformedJson = new SyntaxError('Unexpected token');
    const schemaError = Object.assign(new Error('Invalid input'), {
      name: 'ZodError',
    });

    expect(isRequestValidationError(malformedJson)).toBe(true);
    expect(isRequestValidationError(schemaError)).toBe(true);

    for (const error of [malformedJson, schemaError]) {
      const response = apiErrorResponse(error);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          retryable: false,
        },
      });
    }
  });
});
