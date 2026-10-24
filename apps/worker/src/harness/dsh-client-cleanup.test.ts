import { describe, expect, it } from 'vitest';
import { HandlerError } from '../errors.js';
import {
  attachAssistantFailureUsage,
  getAssistantFailureUsage,
} from './dsh/assistant-outcome.js';
import {
  DshClientCleanupError,
  getDshCleanupFailures,
  retainDshCleanupFailure,
  withDshClient,
} from './dsh-client-cleanup.js';

describe('separate execution and cleanup failure evidence', () => {
  it.each([false, true])(
    'preserves the original classified failure and bound usage (frozen=%s)',
    (frozen) => {
      const failure = new HandlerError(
        'DSH_EXECUTION_OUTCOME_UNKNOWN',
        'original',
        false,
      );
      if (frozen) Object.freeze(failure);
      const receipt = {
        usage: { inputTokens: 11, cachedInputTokens: 3, outputTokens: 5 },
        usageComplete: false,
        cacheUsageKnown: false,
      };
      attachAssistantFailureUsage(failure, 'run-one', 1, receipt);
      const cleanup = new HandlerError(
        'DSH_RUNTIME_CLOSE_UNCONFIRMED',
        'cleanup',
        false,
      );
      expect(retainDshCleanupFailure(failure, cleanup)).toBe(failure);
      expect(failure).toMatchObject({
        code: 'DSH_EXECUTION_OUTCOME_UNKNOWN',
        retryable: false,
        message: 'original',
      });
      expect(getAssistantFailureUsage(failure, 'run-one', 1)).toEqual(receipt);
      expect(getAssistantFailureUsage(failure, 'run-other', 1)).toBeUndefined();
      expect(getDshCleanupFailures(failure)).toEqual([cleanup]);
      if (!frozen) expect(failure.cause).toBe(cleanup);
    },
  );

  it('keeps a pre-existing cause and every close failure without mutable-array aliasing', () => {
    const originalCause = Error('original cause');
    const failure = new HandlerError('DENIED', 'denied', false, {
      cause: originalCause,
    });
    const first = Error('first close'),
      second = Error('second close');
    retainDshCleanupFailure(failure, first);
    retainDshCleanupFailure(failure, second);
    expect(failure.cause).toBe(originalCause);
    const failures = getDshCleanupFailures(failure) as unknown[];
    failures.length = 0;
    expect(getDshCleanupFailures(failure)).toEqual([first, second]);
    expect(getDshCleanupFailures({ code: 'DENIED', cause: first })).toEqual([]);
  });

  it('retains a non-object operation failure inside an explicit failed-cleanup aggregate', () => {
    const cleanup = Error('close unconfirmed');
    const failure = retainDshCleanupFailure('operation failed', cleanup);
    expect(failure).toBeInstanceOf(DshClientCleanupError);
    expect(failure).toMatchObject({
      code: 'DSH_CLIENT_CLEANUP_UNCONFIRMED',
      errors: ['operation failed', cleanup],
    });
  });

  it('never turns an otherwise successful operation with failed close into success', async () => {
    const cleanup = Error('close unconfirmed');
    await expect(
      withDshClient(
        {
          close: async () => {
            throw cleanup;
          },
        },
        async () => 'done',
      ),
    ).rejects.toMatchObject({
      code: 'DSH_CLIENT_CLEANUP_UNCONFIRMED',
      errors: [cleanup],
    });
  });
});
