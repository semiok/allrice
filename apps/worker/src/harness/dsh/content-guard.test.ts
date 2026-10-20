import { describe, expect, it } from 'vitest';
import { HandlerError } from '../../errors.js';
import { contentGuardFailure } from './content-guard.js';

describe('content guard failure classification', () => {
  it('preserves an actual source revocation and its non-retryable decision', () => {
    const error = new HandlerError(
      'EMPLOYEE_CONTENT_UNAVAILABLE',
      'revoked',
      false,
    );
    expect(contentGuardFailure(error)).toBe(error);
  });

  it('retains a database deadlock as a system failure without automatic Run replay', () => {
    const cause = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
    });
    const error = contentGuardFailure(cause);
    expect(error).toMatchObject({
      code: 'EMPLOYEE_CONTENT_CHECK_UNAVAILABLE',
      retryable: false,
      cause,
    });
    expect(error.message).not.toMatch(/失效|无法继续使用/);
    expect(error.cause).toBe(cause);
  });
});
