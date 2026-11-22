/** Public-driver-shaped substitutes only; no test here proves a real disconnect. */
import { setImmediate as turn } from 'node:timers/promises';
import postgres, { type ReservedSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { withReservedCallerTransaction } from './caller-transaction.ts';

vi.mock('../company-assets.ts', () => ({
  listCompanyRuleSources: vi.fn(),
  mutateCompanyAsset: vi.fn(),
}));
vi.mock('../employees/employee-content.ts', () => ({
  mutateEmployeeContent: vi.fn(),
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(run: (sql: string) => unknown = () => []) {
  const operations: string[] = [];
  const cancel = vi.fn<() => unknown>();
  const release = vi.fn();
  function query(text: string) {
    let started: Promise<unknown> | undefined;
    return {
      then(yes: (value: unknown) => unknown, no: (error: unknown) => unknown) {
        started ??= Promise.resolve().then(() => {
          operations.push(text);
          return run(text);
        });
        return started.then(yes, no);
      },
      cancel,
    };
  }
  // This is deliberately a partial driver substitute, never a production source.
  const reserved = Object.assign(
    (parts: TemplateStringsArray) => query(parts.join('$')),
    { release, unsafe: query, json: (value: unknown) => value },
  ) as unknown as ReservedSql;
  const db = {
    reserve: vi.fn(async () => reserved),
    PostgresError: postgres.PostgresError,
  };
  return { db, operations, cancel, release, reserved };
}

describe('caller-owned reserved transaction', () => {
  it('commits once, keeps fragments lazy, and closes old handles before pool return', async () => {
    const f = fixture();
    let saved: ReservedSql | undefined;
    let lazy: PromiseLike<unknown> | undefined;
    expect(
      await withReservedCallerTransaction(f.db, async (tx) => {
        saved = tx;
        lazy = tx`select late`;
        const fragment = tx`where true`;
        await tx`select 1 ${fragment}`;
        return 'committed receipt';
      }),
    ).toBe('committed receipt');
    expect(f.operations).toEqual(['begin', 'select 1 $', 'commit']);
    expect(f.release).toHaveBeenCalledTimes(1);
    if (!saved || !lazy) throw new Error('Actual callback handles required');
    const captured = saved;
    expect(() => captured`select after release`).toThrow(
      'authorization_denied',
    );
    await expect(Promise.resolve(lazy)).rejects.toThrow('authorization_denied');
    expect(f.operations).toEqual(['begin', 'select 1 $', 'commit']);
  });

  it('joins an already-started unawaited SQL before COMMIT and actual COMMIT before release', async () => {
    const query = deferred(),
      commit = deferred();
    const entered = deferred();
    const f = fixture((sql) =>
      sql === 'select pending'
        ? query.promise
        : sql === 'commit'
          ? commit.promise
          : [],
    );
    let finished = false;
    const saving = withReservedCallerTransaction(f.db, async (tx) => {
      void tx`select pending`.then(() => undefined);
      entered.resolve();
      return 'receipt';
    }).then((value) => {
      finished = true;
      return value;
    });
    await entered.promise;
    await turn();
    expect(f.operations).toEqual(['begin', 'select pending']);
    expect(finished).toBe(false);
    query.resolve();
    await turn();
    expect(f.operations).toEqual(['begin', 'select pending', 'commit']);
    expect(f.release).not.toHaveBeenCalled();
    commit.resolve();
    expect(await saving).toBe('receipt');
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('awaits actual ROLLBACK and retains an ordinary callback error object', async () => {
    const rollback = deferred(),
      entered = deferred();
    const failure = new Error('caller rejected');
    const f = fixture((sql) =>
      sql === 'rollback' ? (entered.resolve(), rollback.promise) : [],
    );
    const saving = withReservedCallerTransaction(f.db, async () => {
      throw failure;
    }).catch((error: unknown) => error);
    await entered.promise;
    expect(f.release).not.toHaveBeenCalled();
    rollback.resolve();
    expect(await saving).toBe(failure);
    expect(f.operations).toEqual(['begin', 'rollback']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('does not admit a callback after failed BEGIN', async () => {
    const failure = new Error('BEGIN rejected');
    const f = fixture(() => {
      throw failure;
    });
    const work = vi.fn(async () => 'unadmitted');
    await expect(withReservedCallerTransaction(f.db, work)).rejects.toBe(
      failure,
    );
    expect(work).not.toHaveBeenCalled();
    expect(f.operations).toEqual(['begin']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('joins reservation acquisition after abort and returns it without BEGIN', async () => {
    const f = fixture(),
      acquired = deferred<ReservedSql>();
    f.db.reserve.mockReturnValueOnce(acquired.promise);
    const controller = new AbortController(),
      reason = new Error('abort while acquiring');
    const work = vi.fn(async () => 'unadmitted');
    const saving = withReservedCallerTransaction(
      f.db,
      work,
      controller.signal,
    ).catch((error: unknown) => error);
    controller.abort(reason);
    expect(f.release).not.toHaveBeenCalled();
    acquired.resolve(f.reserved);
    expect(await saving).toBe(reason);
    expect(work).not.toHaveBeenCalled();
    expect(f.operations).toEqual([]);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it.each(['rollback', 'release'] as const)(
    'retains original and %s errors together',
    async (stage) => {
      const primary = new Error('caller refusal'),
        cleanup = new Error(stage + ' rejected');
      const f = fixture((sql) => {
        if (stage === 'rollback' && sql === 'rollback') throw cleanup;
        return [];
      });
      if (stage === 'release')
        f.release.mockImplementationOnce(() => {
          throw cleanup;
        });
      const error = await withReservedCallerTransaction(f.db, async () => {
        throw primary;
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw error;
      expect(error.cause).toBe(primary);
      expect(error.errors).toEqual([primary, cleanup]);
      expect(f.operations).toEqual(['begin', 'rollback']);
      expect(f.release).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves unknown COMMIT rejection without a rollback, retry, or shared-pool operation', async () => {
    const transport = Object.assign(
      new Error('substitute connection rejection'),
      { code: 'CONNECTION_CLOSED' },
    );
    const f = fixture((sql) => {
      if (sql === 'commit') throw transport;
      return [];
    });
    await expect(
      withReservedCallerTransaction(f.db, async (tx) => {
        expect(() => tx.end()).toThrow('authorization_denied');
        await tx`select own`;
        return 'not a confirmed receipt';
      }),
    ).rejects.toBe(transport);
    expect(f.operations).toEqual(['begin', 'select own', 'commit']);
    expect(f.db.reserve).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    const other = fixture();
    expect(
      await withReservedCallerTransaction(other.db, async () => 'independent'),
    ).toBe('independent');
    expect(other.operations).toEqual(['begin', 'commit']);
  });

  it('joins callback/Storage work after a substituted query rejection and keeps both failures', async () => {
    const sql = deferred(),
      storage = deferred(),
      entered = deferred();
    const transport = Object.assign(
      new Error('substitute transport rejected'),
      { code: 'CONNECTION_CLOSED' },
    );
    const callbackFailure = new Error('callback cleanup rejected');
    const f = fixture((text) => (text === 'select pending' ? sql.promise : []));
    let finished = false;
    const saving = withReservedCallerTransaction(f.db, async (tx) => {
      void tx`select pending`.catch(() => undefined);
      entered.resolve();
      await storage.promise;
      expect(() => tx`select forbidden`).toThrow('authorization_denied');
      throw callbackFailure;
    }).catch((error: unknown) => {
      finished = true;
      return error;
    });
    await entered.promise;
    sql.reject(transport);
    await turn();
    expect(finished).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
    storage.resolve();
    const error = await saving;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.cause).toBe(callbackFailure);
    expect(error.errors).toEqual([callbackFailure, transport]);
    expect(f.operations).toEqual(['begin', 'select pending']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('joins explicit caller-owned public cancellation, SQL and callback settlement', async () => {
    const sql = deferred(),
      cancelled = deferred(),
      entered = deferred();
    const controller = new AbortController(),
      reason = new Error('caller aborted');
    const f = fixture((text) => (text === 'select pending' ? sql.promise : []));
    f.cancel.mockImplementation(() => cancelled.promise);
    let finished = false;
    const saving = withReservedCallerTransaction(
      f.db,
      async (tx) => {
        const reading = tx`select pending`;
        const result = reading.then(() => 'late result');
        const cancel = () => reading.cancel();
        controller.signal.addEventListener('abort', cancel, { once: true });
        entered.resolve();
        try {
          return await result;
        } finally {
          controller.signal.removeEventListener('abort', cancel);
        }
      },
      controller.signal,
    ).catch((error: unknown) => {
      finished = true;
      return error;
    });
    await entered.promise;
    controller.abort(reason);
    expect(f.cancel).toHaveBeenCalledTimes(1);
    sql.resolve();
    await turn();
    expect(finished).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
    cancelled.resolve();
    expect(await saving).toBe(reason);
    expect(f.operations).toEqual(['begin', 'select pending', 'rollback']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('keeps a confirmed commit result when a later signal aborts', async () => {
    const controller = new AbortController();
    const f = fixture((sql) => {
      if (sql === 'commit') controller.abort(new Error('after commit'));
      return [];
    });
    expect(
      await withReservedCallerTransaction(
        f.db,
        async () => 'committed',
        controller.signal,
      ),
    ).toBe('committed');
    expect(f.operations).toEqual(['begin', 'commit']);
    expect(f.release).toHaveBeenCalledTimes(1);
  });
});
