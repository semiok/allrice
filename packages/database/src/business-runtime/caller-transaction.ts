import type { Sql, TransactionSql } from 'postgres';
import type {
  CompanyAssetMutation,
  EmployeeContentMutation,
  MemoryOriginSelectorProjection,
  RequestContext,
  StoragePort,
} from '@allrice/contracts';
import { createDedicatedDatabase, getDatabase } from '../core/client.ts';
import {
  listCompanyRuleSources,
  mutateCompanyAsset,
} from '../company-assets.ts';
import { mutateEmployeeContent } from '../employees/employee-content.ts';
import { DataAccessError } from '../data.ts';
import { queryLegacyOriginForCaller } from './legacy-origin.ts';

/** Trusted host composition of existing maintenance callers, not a native
 * execution/current-scope producer. Each caller retains its own SQL authority,
 * locks, CAS and dedicated transaction. No SQL handle leaves this factory. */
export function createBusinessRuntimeCaller() {
  return Object.freeze({
    listCompanyRuleSources(
      context: RequestContext,
      organizationId: string,
      signal?: AbortSignal,
    ) {
      return listCompanyRuleSources(
        context,
        organizationId,
        getDatabase(),
        signal,
      );
    },
    mutateCompanyAsset(
      context: RequestContext,
      organizationId: string,
      command: CompanyAssetMutation,
      storage: StoragePort,
      administration = false,
      signal?: AbortSignal,
    ) {
      return mutateCompanyAsset(
        context,
        organizationId,
        command,
        storage,
        administration,
        getDatabase(),
        signal,
      );
    },
    mutateEmployeeContent(
      context: Parameters<typeof mutateEmployeeContent>[0],
      command: EmployeeContentMutation,
      signal?: AbortSignal,
    ) {
      return mutateEmployeeContent(context, command, getDatabase(), signal);
    },
  });
}

type SourceQuery<T> = PromiseLike<T> & { cancel?: () => unknown };

/** @internal NOT exported by the database barrel. Created only in the original
 * caller's transaction callback, after its own authority/lock admission. Source SQL
 * stays in its business owner. The memory owner may consume the bound G5 method
 * below; it receives neither tx nor a transferable participation token.
 *
 * This binding does not fence arbitrary Run/checkpoint writers or supply native
 * module/B/VM qualifications. Those missing producer contracts remain closed.
 */
export function bindCallerSourceQueries(
  tx: TransactionSql | Sql,
  scope: { organizationId: string; workspaceId: string },
  signal?: AbortSignal,
) {
  let accepting = true;
  const queries = new Set<Promise<unknown>>();

  function run<T>(work: () => SourceQuery<T>, ownsCancellation = true) {
    if (!accepting) throw new DataAccessError('authorization_denied');
    signal?.throwIfAborted();
    const promise = (async () => {
      const query = work();
      let cancellationError: unknown;
      let cancellationFailed = false;
      const cancel = () => {
        try {
          query.cancel?.();
        } catch (error) {
          cancellationFailed = true;
          cancellationError = error;
        }
      };
      if (ownsCancellation)
        signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (ownsCancellation && signal?.aborted) cancel();
        let result: T;
        try {
          result = await query;
        } catch (error) {
          if (!ownsCancellation || !signal?.aborted) throw error;
          throw new AggregateError(
            [
              error,
              signal.reason,
              ...(cancellationFailed ? [cancellationError] : []),
            ],
            'caller_source_query_failed_while_signal_aborted',
            { cause: error },
          );
        }
        if (cancellationFailed)
          throw new AggregateError(
            [cancellationError, signal?.reason],
            'caller_source_cancellation_failed',
            { cause: cancellationError },
          );
        signal?.throwIfAborted();
        return result;
      } finally {
        if (ownsCancellation) signal?.removeEventListener('abort', cancel);
      }
    })();
    // A settled, unawaited source failure must still prevent caller commit.
    // Retain only this lexical transaction's actual work until close.
    queries.add(promise);
    void promise.catch(() => {});
    return promise;
  }

  return Object.freeze({
    companyRuleRevision<T>(read: () => SourceQuery<T>) {
      return run(read);
    },
    personalMemorySource<T>(read: () => SourceQuery<T>) {
      return run(read);
    },
    classifyMemoryOrigin(input: MemoryOriginSelectorProjection) {
      // G5 owns its exact cancel/error semantics; only join it here.
      return run(
        () => queryLegacyOriginForCaller(tx, scope, input, signal),
        false,
      );
    },
    async close() {
      accepting = false;
      const results = await Promise.allSettled([...queries]);
      const errors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, 'caller_source_queries_failed', {
          cause: errors[0],
        });
    },
  });
}

/** @internal Preserve the original failure when closing concurrent source
 * work also fails. This closes the lexical query binding, not the SQL tx. */
export async function closeCallerSourceQueries(
  binding: ReturnType<typeof bindCallerSourceQueries>,
  failure: { error: unknown } | null,
) {
  try {
    await binding.close();
  } catch (error) {
    if (!failure) throw error;
    if (
      error instanceof AggregateError &&
      error.errors.every((item: unknown) => item === failure.error)
    )
      return;
    throw new AggregateError(
      [failure.error, error],
      'caller_and_source_cleanup_failed',
      { cause: failure.error },
    );
  }
}

/** @internal Historical comparison fixture; production writers use the
 * dedicated lifecycle below. Join an already-started db.begin and callback.
 * postgres3.4.9 may reject begin on connection close before its callback ends.
 * This starts no transaction and never reports that an unknown commit rolled
 * back. On normal commit, a later abort cannot replace the committed result. */
export async function joinCallerSave<T>(
  transaction: PromiseLike<T>,
  callback: () => Promise<unknown> | undefined,
): Promise<T> {
  let result: T | undefined;
  let failure: { error: unknown } | null = null;
  try {
    result = await transaction;
  } catch (error) {
    failure = { error };
  }
  try {
    await callback();
  } catch (error) {
    if (!failure || failure.error === error) throw error;
    throw new AggregateError(
      [failure.error, error],
      'caller_transaction_and_callback_failed',
      { cause: failure.error },
    );
  }
  if (failure) throw failure.error;
  return result as T;
}

/** @internal Own this dedicated max:1 client's explicit transaction and end.
 * No shared-pool reservation or native begin/scope is used.
 * The existing callers use ordinary queries/fragments, not cursors/streams. */
export async function withDedicatedCallerTransaction<T>(
  db: Pick<ReturnType<typeof getDatabase>, 'options' | 'PostgresError'>,
  work: (tx: Sql) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const dedicated = createDedicatedDatabase(db);
  let accepting = true,
    began = false,
    committing = false,
    uncertain = false;
  let outcome: { value: T } | { error: unknown };
  let endFailure: { error: unknown } | null = null;
  const pending = new Set<Promise<unknown>>();
  const failures: unknown[] = [];
  const check = () => {
    if (!accepting) throw new DataAccessError('authorization_denied');
    signal?.throwIfAborted();
  };
  function observe(promise: Promise<unknown>, sql = false) {
    pending.add(promise);
    void promise.catch((error: unknown) => {
      failures.push(error);
      if (sql) {
        accepting = false;
        // postgres 3.4.9 documents UNDEFINED_VALUE as a local parameter-build
        // error (types.js handleValue), not an unknown transport outcome.
        const undefinedValue =
          error instanceof Error &&
          'code' in error &&
          error.code === 'UNDEFINED_VALUE';
        uncertain ||= !(
          undefinedValue ||
          (error instanceof db.PostgresError && error.severity === 'ERROR')
        );
      }
    });
    return promise;
  }
  async function drain() {
    await Promise.allSettled([...pending]);
  }
  function wrap(value: unknown): unknown {
    if (
      !value ||
      typeof value !== 'object' ||
      !('then' in value) ||
      typeof value.then !== 'function' ||
      !('cancel' in value) ||
      typeof value.cancel !== 'function'
    )
      return value;
    const query = value as PromiseLike<unknown> & { cancel(): unknown };
    let started: Promise<unknown> | undefined;
    const start = () => {
      if (!started) {
        check();
        started = observe(Promise.resolve(query), true);
      }
      return started;
    };
    const guarded = new Proxy(query, {
      get(target, key) {
        if (key === 'then' || key === 'catch' || key === 'finally')
          return (...args: unknown[]) => {
            const promise = start();
            return Reflect.apply(Reflect.get(promise, key), promise, args);
          };
        // Native cancel returns void/null, not its cancellation transport.
        // drain joins the original SQL only; it cannot join that transport.
        if (key === 'cancel') return () => query.cancel();
        if (key === 'execute')
          return () => {
            start();
            return guarded;
          };
        const member: unknown = Reflect.get(target, key);
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => {
          check();
          if (
            ['cursor', 'forEach', 'readable', 'writable', 'stream'].includes(
              String(key),
            )
          )
            throw new DataAccessError('authorization_denied');
          const result: unknown = Reflect.apply(member, target, args);
          return result === target ? guarded : wrap(result);
        };
      },
    });
    return guarded;
  }
  const tx = new Proxy(dedicated, {
    apply(target, receiver, args) {
      check();
      return wrap(Reflect.apply(target, receiver, args));
    },
    get(target, key) {
      check();
      if (
        !['unsafe', 'file', 'json', 'array', 'typed', 'types'].includes(
          String(key),
        )
      )
        throw new DataAccessError('authorization_denied');
      const member: unknown = Reflect.get(target, key);
      return typeof member === 'function'
        ? (...args: unknown[]) => {
            check();
            return wrap(Reflect.apply(member, target, args));
          }
        : member;
    },
  });
  const includes = (error: unknown, item: unknown): boolean =>
    error === item ||
    (error instanceof AggregateError &&
      error.errors.some((child: unknown) => includes(child, item)));
  try {
    signal?.throwIfAborted();
    await dedicated`begin`;
    began = true;
    signal?.throwIfAborted();
    const result = await work(tx);
    accepting = false;
    await drain();
    if (failures.length) throw failures[0];
    signal?.throwIfAborted();
    committing = true;
    await dedicated`commit`;
    outcome = { value: result };
  } catch (error) {
    accepting = false;
    await drain();
    const errors = [
      error,
      ...failures.filter((item) => !includes(error, item)),
    ];
    if (began && !committing && !uncertain) {
      try {
        await dedicated`rollback`;
      } catch (rollbackError) {
        errors.push(rollbackError);
      }
    }
    outcome = {
      error:
        errors.length === 1
          ? error
          : new AggregateError(
              errors,
              'caller_transaction_and_cleanup_failed',
              { cause: error },
            ),
    };
    // A failed COMMIT or transport query is unknown: never replay or claim
    // rollback. A bounded end cannot turn an unknown commit into rollback.
  } finally {
    accepting = false;
    try {
      await dedicated.end({ timeout: 5 });
    } catch (error) {
      endFailure = { error };
    }
  }
  if ('error' in outcome) {
    if (endFailure)
      throw new AggregateError(
        [outcome.error, endFailure.error],
        'caller_end_failed',
        { cause: outcome.error },
      );
    throw outcome.error;
  }
  if (endFailure) throw endFailure.error;
  return outcome.value;
}
