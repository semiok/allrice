/** Public-driver-shaped substitutes only; no test here proves a real disconnect. */
import { setImmediate as turn } from 'node:timers/promises';
import postgres, { type ReservedSql, type Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDedicatedDatabase } from '../core/client.ts';
import { withDedicatedCallerTransaction } from './caller-transaction.ts';

vi.mock('../core/client.ts', () => ({
  createDedicatedDatabase: vi.fn(),
  getDatabase: vi.fn(),
}));
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
  const cancel = vi.fn<() => void | null>(() => null);
  const end = vi.fn(async () => {});
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
  const session = Object.assign(
    (parts: TemplateStringsArray) => query(parts.join('$')),
    { release, unsafe: query, json: (value: unknown) => value },
  ) as unknown as ReservedSql;
  const dedicated = {
    reserve: vi.fn(async () => session),
    end,
  } as unknown as Sql;
  const db = {
    options: {},
    reserve: vi.fn(),
    end: vi.fn(),
    PostgresError: postgres.PostgresError,
  } as unknown as Sql;
  vi.mocked(createDedicatedDatabase).mockReturnValueOnce(dedicated);
  return { db, operations, cancel, end, dedicated, release };
}

describe('caller-owned dedicated transaction', () => {
  beforeEach(() => vi.mocked(createDedicatedDatabase).mockReset());
  it('copies the entire trusted native configuration without changing the shared client', async () => {
    const actual = await vi.importActual<{
      createDedicatedDatabase: typeof createDedicatedDatabase;
    }>('../core/client.ts');
    const source = postgres('postgres://fixture:fixture@127.0.0.1:1/fixture', {
      max: 3,
      ssl: { rejectUnauthorized: true },
      connection: { search_path: 'fixture,public', statement_timeout: 5432 },
      types: {
        number: { to: 23, from: [23], serialize: String, parse: Number },
      },
      transform: { column: { from: (name) => name.toUpperCase() } },
    });
    const dedicated = actual.createDedicatedDatabase(source);
    try {
      expect(dedicated).not.toBe(source);
      expect(dedicated.options).not.toBe(source.options);
      expect(dedicated.options).toEqual({ ...source.options, max: 1 });
      expect(source.options.max).toBe(3);
      expect(dedicated.options.ssl).toBe(source.options.ssl);
      expect(dedicated.options.types).toBe(source.options.types);
      expect(dedicated.options.transform).toBe(source.options.transform);
      for (const field of ['shared', 'parameters', 'parsers', 'serializers'])
        expect(Reflect.get(dedicated.options, field)).not.toBe(
          Reflect.get(source.options, field),
        );
      const arrayMap = (options: object) =>
        (Reflect.get(options, 'shared') as { typeArrayMap: object })
          .typeArrayMap;
      expect(arrayMap(dedicated.options)).not.toBe(arrayMap(source.options));
    } finally {
      await dedicated.end({ timeout: 5 });
      await source.end({ timeout: 5 });
    }
  });
  it('commits once, keeps fragments lazy, and closes old handles before client end', async () => {
    const f = fixture();
    let saved: Sql | undefined;
    let lazy: PromiseLike<unknown> | undefined;
    expect(
      await withDedicatedCallerTransaction(f.db, async (tx) => {
        saved = tx;
        lazy = tx`select late`;
        const fragment = tx`where true`;
        await tx`select 1 ${fragment}`;
        return 'committed receipt';
      }),
    ).toBe('committed receipt');
    expect(f.operations).toEqual(['begin', 'select 1 $', 'commit']);
    expect(f.end).toHaveBeenCalledTimes(1);
    expect(f.dedicated.reserve).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    if (!saved || !lazy) throw new Error('Actual callback handles required');
    const captured = saved;
    expect(() => captured`select after end`).toThrow('authorization_denied');
    await expect(Promise.resolve(lazy)).rejects.toThrow('authorization_denied');
    expect(f.operations).toEqual(['begin', 'select 1 $', 'commit']);
  });

  it('rereads a started result after end and abort without dispatching again', async () => {
    const rows = [{ value: 'same result object' }];
    const f = fixture((text) => (text === 'select stable' ? rows : []));
    const controller = new AbortController();
    const handles: { query?: Promise<unknown> } = {};
    await withDedicatedCallerTransaction(
      f.db,
      async (tx) => {
        handles.query = tx`select stable`;
        expect(await handles.query).toBe(rows);
      },
      controller.signal,
    );
    controller.abort(new Error('after completed SQL'));
    if (!handles.query) throw new Error('Actual started query required');
    const query = handles.query;
    expect(await query.then((value) => value)).toBe(rows);
    expect(await query.catch(() => 'unexpected rejection')).toBe(rows);
    const final = vi.fn();
    expect(await query.finally(final)).toBe(rows);
    expect(final).toHaveBeenCalledTimes(1);
    expect(f.operations).toEqual(['begin', 'select stable', 'commit']);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it('rereads the original started query error while admission and old tx stay closed', async () => {
    const failure = Object.assign(new Error('local undefined parameter'), {
      code: 'UNDEFINED_VALUE',
    });
    const f = fixture((text) => {
      if (text === 'select rejected') throw failure;
      return [];
    });
    const handles: { query?: Promise<unknown> } = {};
    await expect(
      withDedicatedCallerTransaction(f.db, async (tx) => {
        const query = tx`select rejected`;
        handles.query = query;
        expect(await query.catch((error: unknown) => error)).toBe(failure);
        expect(await query.catch((error: unknown) => error)).toBe(failure);
        expect(() => tx`select forbidden`).toThrow('authorization_denied');
      }),
    ).rejects.toBe(failure);
    if (!handles.query) throw new Error('Actual rejected query required');
    const query = handles.query;
    expect(await query.then(undefined, (error: unknown) => error)).toBe(
      failure,
    );
    expect(await query.catch((error: unknown) => error)).toBe(failure);
    const final = vi.fn();
    await expect(query.finally(final)).rejects.toBe(failure);
    expect(final).toHaveBeenCalledTimes(1);
    expect(f.operations).toEqual(['begin', 'select rejected', 'rollback']);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it('joins an already-started unawaited SQL before COMMIT and actual COMMIT before end', async () => {
    const query = deferred(),
      commit = deferred(),
      ended = deferred();
    const entered = deferred();
    const f = fixture((sql) =>
      sql === 'select pending'
        ? query.promise
        : sql === 'commit'
          ? commit.promise
          : [],
    );
    f.end.mockReturnValueOnce(ended.promise);
    let finished = false;
    const saving = withDedicatedCallerTransaction(f.db, async (tx) => {
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
    expect(f.end).not.toHaveBeenCalled();
    commit.resolve();
    await turn();
    expect(finished).toBe(false);
    expect(f.end).toHaveBeenCalledWith({ timeout: 5 });
    expect(f.release).toHaveBeenCalledTimes(1);
    ended.resolve();
    expect(await saving).toBe('receipt');
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it('awaits actual ROLLBACK and retains an ordinary callback error object', async () => {
    const rollback = deferred(),
      entered = deferred();
    const failure = new Error('caller rejected');
    const f = fixture((sql) =>
      sql === 'rollback' ? (entered.resolve(), rollback.promise) : [],
    );
    const saving = withDedicatedCallerTransaction(f.db, async () => {
      throw failure;
    }).catch((error: unknown) => error);
    await entered.promise;
    expect(f.end).not.toHaveBeenCalled();
    rollback.resolve();
    expect(await saving).toBe(failure);
    expect(f.operations).toEqual(['begin', 'rollback']);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it('does not admit a callback after failed BEGIN', async () => {
    const failure = new Error('BEGIN rejected');
    const f = fixture(() => {
      throw failure;
    });
    const work = vi.fn(async () => 'unadmitted');
    await expect(withDedicatedCallerTransaction(f.db, work)).rejects.toBe(
      failure,
    );
    expect(work).not.toHaveBeenCalled();
    expect(f.operations).toEqual(['begin']);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it('joins an in-progress BEGIN after abort, rolls back, and ends without admitting the callback', async () => {
    const begin = deferred(),
      entered = deferred();
    const f = fixture((text) =>
      text === 'begin' ? (entered.resolve(), begin.promise) : [],
    );
    const controller = new AbortController(),
      reason = new Error('abort during handshake');
    const work = vi.fn(async () => 'unadmitted');
    const saving = withDedicatedCallerTransaction(
      f.db,
      work,
      controller.signal,
    ).catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    expect(f.end).not.toHaveBeenCalled();
    begin.resolve();
    expect(await saving).toBe(reason);
    expect(work).not.toHaveBeenCalled();
    expect(f.operations).toEqual(['begin', 'rollback']);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it.each(['rollback', 'release', 'end'] as const)(
    'retains original and %s errors together',
    async (stage) => {
      const primary = new Error('caller refusal'),
        cleanup = new Error(stage + ' rejected'),
        ending = new Error('end rejected after release');
      const f = fixture((sql) => {
        if (stage === 'rollback' && sql === 'rollback') throw cleanup;
        return [];
      });
      if (stage === 'end') f.end.mockRejectedValueOnce(cleanup);
      if (stage === 'release') {
        f.release.mockImplementationOnce(() => {
          throw cleanup;
        });
        f.end.mockRejectedValueOnce(ending);
      }
      const error = await withDedicatedCallerTransaction(f.db, async () => {
        throw primary;
      }).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw error;
      expect(error.cause).toBe(primary);
      expect(error.errors).toEqual(
        stage === 'release' ? [primary, cleanup, ending] : [primary, cleanup],
      );
      expect(f.operations).toEqual(['begin', 'rollback']);
      expect(f.end).toHaveBeenCalledTimes(1);
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
      withDedicatedCallerTransaction(f.db, async (tx) => {
        expect(() => tx.end()).toThrow('authorization_denied');
        await tx`select own`;
        return 'not a confirmed receipt';
      }),
    ).rejects.toBe(transport);
    expect(f.operations).toEqual(['begin', 'select own', 'commit']);
    expect(createDedicatedDatabase).toHaveBeenCalledWith(f.db);
    expect(f.db.reserve).not.toHaveBeenCalled();
    expect(f.db.end).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(f.end).toHaveBeenCalledTimes(1);
    const other = fixture();
    expect(
      await withDedicatedCallerTransaction(other.db, async () => 'independent'),
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
    const saving = withDedicatedCallerTransaction(f.db, async (tx) => {
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
    expect(f.end).not.toHaveBeenCalled();
    storage.resolve();
    const error = await saving;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.cause).toBe(callbackFailure);
    expect(error.errors).toEqual([callbackFailure, transport]);
    expect(f.operations).toEqual(['begin', 'select pending']);
    expect(f.end).toHaveBeenCalledTimes(1);
  });

  it.each([
    { cancelResult: undefined, rejectSQL: false },
    { cancelResult: null, rejectSQL: true },
  ])(
    'requests native cancel $cancelResult and joins the original SQL (reject=$rejectSQL)',
    async ({ cancelResult, rejectSQL }) => {
      const sql = deferred(),
        entered = deferred();
      const controller = new AbortController(),
        reason = new Error('caller aborted');
      const sqlFailure = new Error('original pending SQL rejection');
      const f = fixture((text) =>
        text === 'select pending' ? sql.promise : [],
      );
      f.cancel.mockReturnValue(cancelResult);
      let finished = false;
      const saving = withDedicatedCallerTransaction(
        f.db,
        async (tx) => {
          const reading = tx`select pending`;
          const result = reading.then(() => 'late result');
          const cancel = () => {
            expect(reading.cancel()).toBe(cancelResult);
          };
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
      await turn();
      expect(finished).toBe(false);
      expect(f.end).not.toHaveBeenCalled();
      if (rejectSQL) sql.reject(sqlFailure);
      else sql.resolve();
      expect(await saving).toBe(rejectSQL ? sqlFailure : reason);
      expect(f.operations).toEqual(
        rejectSQL
          ? ['begin', 'select pending']
          : ['begin', 'select pending', 'rollback'],
      );
      expect(f.end).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a confirmed commit result when a later signal aborts', async () => {
    const controller = new AbortController();
    const f = fixture((sql) => {
      if (sql === 'commit') controller.abort(new Error('after commit'));
      return [];
    });
    expect(
      await withDedicatedCallerTransaction(
        f.db,
        async () => 'committed',
        controller.signal,
      ),
    ).toBe('committed');
    expect(f.operations).toEqual(['begin', 'commit']);
    expect(f.end).toHaveBeenCalledTimes(1);
  });
});
