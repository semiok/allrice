import type { TransactionSql } from 'postgres';
import type {
  CompanyAssetMutation,
  EmployeeContentMutation,
  MemoryOriginSelectorProjection,
  RequestContext,
  StoragePort,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import {
  listCompanyRuleSources,
  mutateCompanyAsset,
} from '../company-assets.ts';
import { mutateEmployeeContent } from '../employees/employee-content.ts';
import { DataAccessError } from '../data.ts';
import { queryLegacyOriginForCaller } from './legacy-origin.ts';

/** Trusted host composition of existing maintenance callers, not a native
 * execution/current-scope producer. Each caller retains its own SQL authority,
 * locks, CAS and db.begin. No transaction capability leaves this factory. */
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
 * caller's db.begin closure, after its own authority/lock admission. Source SQL
 * stays in its business owner. The memory owner may consume the bound G5 method
 * below; it receives neither tx nor a transferable participation token.
 *
 * This binding does not fence arbitrary Run/checkpoint writers or supply native
 * module/B/VM qualifications. Those missing producer contracts remain closed.
 */
export function bindCallerSourceQueries(
  tx: TransactionSql,
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

/** @internal Join the original caller's already-started db.begin and callback.
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
