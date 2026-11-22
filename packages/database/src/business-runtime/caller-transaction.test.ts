/** Local lifecycle fixtures only; these mocks never qualify a production caller. */
import { setImmediate as turn } from 'node:timers/promises';
import type { TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  bindCallerSourceQueries,
  closeCallerSourceQueries,
  joinCallerSave,
} from './caller-transaction.ts';

vi.mock('../company-assets.ts', () => ({
  listCompanyRuleSources: vi.fn(),
  mutateCompanyAsset: vi.fn(),
}));
vi.mock('../employees/employee-content.ts', () => ({
  mutateEmployeeContent: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const scope = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '10000000-0000-4000-8000-000000000002',
};
function binding(signal?: AbortSignal) {
  // No SQL method is used by these source-query lifecycle fixtures.
  return bindCallerSourceQueries({} as TransactionSql, scope, signal);
}

describe('original caller source-query lifetime', () => {
  it('closes admission before awaiting active SQL, without invoking a late source', async () => {
    const source = binding();
    const sql = deferred<string>();
    const reading = source.companyRuleRevision(() => sql.promise);
    let closed = false;
    const closing = source.close().then(() => {
      closed = true;
    });
    const late = vi.fn(() => Promise.resolve('late'));
    expect(() => source.companyRuleRevision(late)).toThrow(
      'authorization_denied',
    );
    expect(late).not.toHaveBeenCalled();
    await turn();
    expect(closed).toBe(false);
    sql.resolve('actual row');
    expect(await reading).toBe('actual row');
    await closing;
    expect(closed).toBe(true);
  });

  it('requests SQL cancellation but waits for actual settlement before rejecting', async () => {
    const controller = new AbortController();
    const source = binding(controller.signal);
    const sql = deferred<string>();
    const cancel = vi.fn();
    const query = Object.assign(sql.promise, { cancel });
    const reason = new Error('caller stopped');
    let ended = false;
    const reading = source.personalMemorySource(() => query);
    const observed = reading.catch((error: unknown) => {
      ended = true;
      return error;
    });
    controller.abort(reason);
    expect(cancel).toHaveBeenCalledTimes(1);
    await turn();
    expect(ended).toBe(false);
    sql.resolve('late body must not escape');
    expect(await observed).toBe(reason);
    await closeCallerSourceQueries(source, { error: reason });
  });

  it('does not start an already-cancelled source query', async () => {
    const controller = new AbortController();
    const reason = new Error('revoked before source');
    controller.abort(reason);
    const read = vi.fn(() => Promise.resolve('body'));
    expect(() => binding(controller.signal).personalMemorySource(read)).toThrow(
      reason,
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps an un-aborted SQL failure as the original object', async () => {
    const source = binding();
    const sql = deferred<string>();
    const failure = new Error('actual SQL failure');
    const reading = source.companyRuleRevision(() => sql.promise);
    sql.reject(failure);
    await expect(reading).rejects.toBe(failure);
    await closeCallerSourceQueries(source, { error: failure });
  });

  it('retains both actual SQL failure and abort reason without guessing SQLSTATE cause', async () => {
    const controller = new AbortController();
    const source = binding(controller.signal);
    const sql = deferred<string>();
    const failure = Object.assign(new Error('actual SQL failure'), {
      code: '57014',
    });
    const reason = new Error('independent revocation');
    const reading = source.companyRuleRevision(() =>
      Object.assign(sql.promise, { cancel: vi.fn() }),
    );
    const observed = reading.catch((error: unknown) => error);
    controller.abort(reason);
    sql.reject(failure);
    const error = await observed;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.cause).toBe(failure);
    expect(error.errors).toEqual([failure, reason]);
    await closeCallerSourceQueries(source, { error });
  });

  it('still joins SQL if requesting cancellation itself throws', async () => {
    const controller = new AbortController();
    const source = binding(controller.signal);
    const sql = deferred<string>();
    const cancelFailure = new Error('cancel transport failed');
    const reason = new Error('caller abort');
    const reading = source.personalMemorySource(() =>
      Object.assign(sql.promise, {
        cancel() {
          throw cancelFailure;
        },
      }),
    );
    const observed = reading.catch((error: unknown) => error);
    controller.abort(reason);
    sql.resolve('late');
    const error = await observed;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.cause).toBe(cancelFailure);
    expect(error.errors).toEqual([cancelFailure, reason]);
    await closeCallerSourceQueries(source, { error });
  });

  it('refuses commit after an unawaited source has already failed', async () => {
    const source = binding();
    const failure = new Error('settled source failure');
    source.companyRuleRevision(() => Promise.reject(failure));
    await turn();
    await expect(source.close()).rejects.toMatchObject({
      message: 'caller_source_queries_failed',
      errors: [failure],
      cause: failure,
    });
  });

  it('retains a primary caller error when pending source cleanup also rejects', async () => {
    const source = binding();
    const sql = deferred<string>();
    const pending = source
      .companyRuleRevision(() => sql.promise)
      .catch((error: unknown) => error);
    const primary = new Error('original caller failed');
    const sourceFailure = new Error('source also failed');
    const closing = closeCallerSourceQueries(source, { error: primary }).catch(
      (error: unknown) => error,
    );
    sql.reject(sourceFailure);
    expect(await pending).toBe(sourceFailure);
    const combined = await closing;
    expect(combined).toBeInstanceOf(AggregateError);
    if (!(combined instanceof AggregateError)) throw combined;
    expect(combined.cause).toBe(primary);
    expect(combined.errors[0]).toBe(primary);
    expect(combined.errors[1]).toBeInstanceOf(AggregateError);
    expect((combined.errors[1] as AggregateError).errors).toEqual([
      sourceFailure,
    ]);
  });
});

describe('original begin/callback settlement', () => {
  it('does not finish on native connection-close rejection while callback cleanup is pending', async () => {
    const work = deferred<void>();
    const native = deferred<string>();
    const failure = new Error('connection closed');
    let finished = false;
    const joined = joinCallerSave(native.promise, () => work.promise).catch(
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    native.reject(failure);
    await turn();
    expect(finished).toBe(false);
    work.resolve();
    expect(await joined).toBe(failure);
  });

  it('waits for actual commit even after the query/callback has returned', async () => {
    const commit = deferred<string>();
    let finished = false;
    const joined = joinCallerSave(commit.promise, () => Promise.resolve()).then(
      (value) => {
        finished = true;
        return value;
      },
    );
    await turn();
    expect(finished).toBe(false);
    commit.resolve('committed receipt');
    expect(await joined).toBe('committed receipt');
  });

  it('preserves the begin and callback failures after both have settled', async () => {
    const work = deferred<void>();
    void work.promise.catch(() => {});
    const failure = new Error('native begin closed');
    const sqlFailure = new Error('callback query rejected');
    const joined = joinCallerSave(
      Promise.reject(failure),
      () => work.promise,
    ).catch((error: unknown) => error);
    work.reject(sqlFailure);
    const error = await joined;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.cause).toBe(failure);
    expect(error.errors).toEqual([failure, sqlFailure]);
  });

  it('keeps an ordinary rollback error identity without double wrapping', async () => {
    const failure = new Error('original caller rejected');
    const work = Promise.reject(failure);
    void work.catch(() => {});
    await expect(
      joinCallerSave(Promise.reject(failure), () => work),
    ).rejects.toBe(failure);
  });

  it('preserves a failed BEGIN when no callback was admitted', async () => {
    const failure = new Error('BEGIN failed');
    await expect(
      joinCallerSave(Promise.reject(failure), () => undefined),
    ).rejects.toBe(failure);
  });
});
