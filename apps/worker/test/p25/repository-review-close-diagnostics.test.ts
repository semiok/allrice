import { describe, expect, it, vi } from 'vitest';
import { DshRuntimeCloseError } from '../../src/harness/dsh-protocol-client.js';
import {
  closeReviewRuntime,
  reviewCloseError,
  reviewCloseRpc,
  reviewCloseReceipt,
} from './repository-review-close-diagnostics.fixture.js';

describe('repository-review CI close diagnostics', () => {
  it('projects only stage booleans and RPC identities, without invoking getters', () => {
    const secret = 'sk-synthetic-secret /private/path human content';
    const getter = vi.fn(() => {
      throw Error(secret);
    });
    const payload = {
      action: 'start',
      kind: 'tool',
      arguments: secret,
      callId: secret,
      nativeSessionId: secret,
      version: 1,
      sdkShutdown: false,
      rootDisposed: true,
      priorFramesFlushed: true,
    };
    Object.defineProperty(payload, 'untrusted', { get: getter });
    expect(reviewCloseRpc('allrice/progress', payload)).toEqual({
      method: 'allrice/progress',
      action: 'start',
      kind: 'tool',
    });
    expect(reviewCloseReceipt(payload)).toEqual({
      version: 1,
      sdkShutdown: false,
      rootDisposed: true,
      priorFramesFlushed: true,
    });
    Object.defineProperty(payload, 'action', { get: getter });
    Object.defineProperty(payload, 'sdkShutdown', { get: getter });
    expect(reviewCloseRpc(secret, payload)).toEqual({
      method: null,
      action: null,
      kind: 'tool',
    });
    expect(reviewCloseReceipt(payload).sdkShutdown).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(reviewCloseError(Error('task_progress_call_missing'))).toEqual({
      name: 'Error',
      message: 'task_progress_call_missing',
    });
    expect(JSON.stringify(reviewCloseError(Error(secret)))).not.toContain(
      secret,
    );
  });

  const variants = ['plain', 'subclass', 'slice', 'getter'] as const;
  it.each(variants)('logs nested errors safely: %s', async (variant) => {
    const secrets = [
      'sk-synthetic-secret',
      '真人正文不要写进诊断',
      '/Users/private/synthetic-path',
      'https://private.invalid/path?token=secret',
      'synthetic stderr content',
    ];
    class LeakyArray extends Array {
      toJSON() {
        return secrets;
      }
    }
    const taint = (array: unknown[]) => {
      if (variant === 'subclass')
        Object.setPrototypeOf(array, LeakyArray.prototype);
      if (variant === 'slice')
        Object.defineProperty(array, 'slice', {
          value: () => ({ map: () => secrets }),
        });
      if (variant === 'getter')
        Object.defineProperty(array, array.length, {
          get: () => {
            throw Error(secrets[0]);
          },
        });
      return array;
    };
    const safeEvidence = {
      process: {
        state: 'exited' as const,
        stdioClosed: true,
        exitCode: 0,
        signal: null,
      },
      shutdownAcknowledged: true,
      wrapperCleanupConfirmed: false,
      emptyTransportClosed: false,
      terminationAttempted: null,
    };
    const evidence = { ...safeEvidence, secrets };
    const bodyError = new Error('DSH_CLOSE_OWNER_CONFLICT', {
      cause: new Error(secrets.join(' ')),
    });
    const innerError = Object.assign(
      new Error('DSH_CLOSE_EVIDENCE_WRITE_UNCONFIRMED'),
      { code: '40P01' },
    );
    const cycle = Object.assign(new Error(secrets.join(' ')), {
      code: 'EPIPE',
    });
    cycle.cause = cycle;
    const cleanupError = new AggregateError(
      [
        new DshRuntimeCloseError(evidence),
        new AggregateError(
          [innerError],
          'DSH runtime close observation remains unconfirmed',
          { cause: cycle },
        ),
      ],
      'DSH runtime closure remains unconfirmed',
    );
    taint(cleanupError.errors);
    const before = structuredClone(evidence);
    const events: string[] = [];
    const adapter = {
      close: vi.fn(async () => {
        events.push('adapter.close');
        throw cleanupError;
      }),
      runtimeClosureInventory: () => {
        events.push('inventory');
        return taint([
          {
            state: 'unconfirmed',
            processState: 'exited',
            stdioClosed: true,
            exitCode: 0,
            signal: null,
            shutdownAcknowledged: true,
            wrapperCleanupConfirmed: false,
            terminationAttempted: null,
            id: secrets[2],
            lease_token: secrets[0],
            secrets,
          },
        ]);
      },
    };
    const clients = [
      {
        closureEvidence: () => {
          events.push('closureEvidence');
          return evidence;
        },
      },
    ];
    const log = vi.spyOn(console, 'info').mockImplementation(() => {
      events.push('log');
    });
    try {
      await expect(
        (async () => {
          try {
            try {
              throw bodyError;
            } finally {
              await closeReviewRuntime({ adapter, clients, bodyError });
            }
          } finally {
            events.push('fixture.cleanup');
          }
        })(),
      ).rejects.toBe(cleanupError);
      expect(adapter.close).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        'adapter.close',
        'closureEvidence',
        'inventory',
        'log',
        'fixture.cleanup',
      ]);
      expect(log).toHaveBeenCalledTimes(1);
      const [prefix, serialized] = log.mock.calls[0]!;
      expect(prefix).toBe('[repository-review-close]');
      const output = JSON.parse(serialized);
      expect(output.bodyError.message).toBe('DSH_CLOSE_OWNER_CONFLICT');
      expect(output.cleanupError.message).toBe(cleanupError.message);
      expect(output.cleanupError.errors[0]).toMatchObject({
        code: 'DSH_RUNTIME_CLOSE_UNCONFIRMED',
        evidence: safeEvidence,
      });
      expect(output.cleanupError.errors[1].errors[0].message).toBe(
        innerError.message,
      );
      expect(output.cleanupError.errors[1].errors[0].code).toBe('40P01');
      expect(output.cleanupError.errors[1].cause.code).toBe('EPIPE');
      expect(output.cleanupError.errors[1].cause.cause).toEqual({
        omitted: 'cycle',
      });
      expect(output.clients).toEqual([safeEvidence]);
      expect(output.inventory).toEqual([
        { state: 'unconfirmed', ...safeEvidence, emptyTransportClosed: null },
        ...(variant === 'getter' ? [{ omitted: 'non-data' }] : []),
      ]);
      if (variant === 'getter')
        expect(output.cleanupError.errors[2]).toEqual({ omitted: 'non-data' });
      for (const secret of secrets) expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('stack');
      expect(evidence).toEqual(before);
      expect(cleanupError.errors[1].errors[0]).toBe(innerError);
      expect(bodyError.cause).toBeInstanceOf(Error);
    } finally {
      log.mockRestore();
    }
  });

  it('retains the original body failure when runtime cleanup succeeds', async () => {
    const bodyError = new Error('DSH_CLOSE_OWNER_CONFLICT');
    const adapter = {
      close: vi.fn(async () => {}),
      runtimeClosureInventory: () => [],
    };
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await expect(
        Promise.reject(bodyError).finally(() =>
          closeReviewRuntime({ adapter, clients: [], bodyError }),
        ),
      ).rejects.toBe(bodyError);
      expect(adapter.close).toHaveBeenCalledTimes(1);
      const output = JSON.parse(log.mock.calls[0]![1]);
      expect(output.bodyError.message).toBe(bodyError.message);
      expect(output.cleanupError).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it.each(['inventory', 'console'])(
    'preserves errors if %s throws',
    async (at) => {
      const bodyError = Error('DSH_CLOSE_OWNER_CONFLICT');
      const closeError = Error('DSH_CLOSE_EVIDENCE_CONFLICT');
      const cleanup = vi.fn();
      const adapter = {
        close: vi.fn(async () => {
          if (at === 'inventory') throw closeError;
        }),
        runtimeClosureInventory: () => {
          if (at === 'inventory') throw Error('inspection failed');
          return [];
        },
      };
      const log = vi.spyOn(console, 'info').mockImplementation(() => {
        throw Error('console failed');
      });
      try {
        await expect(
          Promise.reject(bodyError)
            .finally(() =>
              closeReviewRuntime({ adapter, clients: [], bodyError }),
            )
            .finally(cleanup),
        ).rejects.toBe(at === 'inventory' ? closeError : bodyError);
        expect(adapter.close).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    },
  );

  it('bounds deep and wide errors at the same logging exit', async () => {
    let failure: Error = new Error('DSH_CLOSE_EVIDENCE_CONFLICT');
    for (let index = 0; index < 100; index++)
      failure = new AggregateError(
        Array(20).fill(failure),
        'untrusted content',
        {
          cause: failure,
        },
      );
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await expect(
        closeReviewRuntime({
          adapter: {
            close: async () => {
              throw failure;
            },
            runtimeClosureInventory: () => [],
          },
          clients: [],
        }),
      ).rejects.toBe(failure);
      const serialized = log.mock.calls[0]![1] as string;
      expect(serialized).toContain('"omitted":"limit"');
      expect(serialized).toContain('"omittedErrors":12');
      expect(serialized.length).toBeLessThan(10000);
      expect(serialized).not.toContain('untrusted content');
    } finally {
      log.mockRestore();
    }
  });
});
