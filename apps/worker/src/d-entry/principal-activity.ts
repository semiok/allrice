import {
  DEntryPrincipalIssueSchema,
  type DEntryPrincipalActivity,
  type DEntryPrincipalIssue,
} from '@allrice/d-entry-principal/types';
import type { ResolvedDEntryNativeOwner } from './native-owner.js';

export function assertDEntryPrincipalIssueForOwner(
  input: DEntryPrincipalIssue,
  owner: ResolvedDEntryNativeOwner,
) {
  const { identity } = DEntryPrincipalIssueSchema.parse(input);
  if (
    identity.organizationId !== owner.receipt.binding.organizationId ||
    identity.personId !== owner.receipt.binding.personId ||
    identity.workspaceId !== owner.endpoint.workspaceId ||
    identity.employeeInstanceId !== owner.endpoint.employeeInstanceId ||
    identity.employeeRevision !== owner.endpoint.employeeRevision ||
    identity.employeeVersionId !== owner.endpoint.employeeVersionId
  )
    throw Error('PRINCIPAL_OWNER_MISMATCH');
}
/** Scope-specific inert child ownership shared by the two existing catalogs.
 * No source/authority cache and no shared job/VM cancellation. */
export function createDEntryPrincipalChildren(lifetime: AbortSignal) {
  const stopped = new AbortController();
  const children = new Set<DEntryPrincipalActivity>();
  let closing: Promise<void> | undefined;
  const active = AbortSignal.any([lifetime, stopped.signal]);
  return {
    acquire(input: {
      signal: AbortSignal;
      assertCurrent(signal: AbortSignal): Promise<void>;
      acquire(signal: AbortSignal): DEntryPrincipalActivity;
    }): DEntryPrincipalActivity {
      active.throwIfAborted();
      input.signal.throwIfAborted();
      const abort = new AbortController();
      const signal = AbortSignal.any([active, input.signal, abort.signal]);
      let child: DEntryPrincipalActivity | undefined, acquisitionError: unknown;
      let acquisitionFailed = false;
      let running: ReturnType<DEntryPrincipalActivity['run']> | undefined;
      let joined: Promise<void> | undefined;
      const activity: DEntryPrincipalActivity = {
        run(caller) {
          if (signal.aborted || joined)
            return Promise.reject(Error('PRINCIPAL_SCOPE_CLOSED'));
          if (running) return running;
          const current = AbortSignal.any([signal, caller]);
          running = Promise.resolve().then(async () => {
            current.throwIfAborted();
            if (acquisitionFailed) throw acquisitionError;
            if (!child) throw Error('PRINCIPAL_ACQUISITION_UNKNOWN');
            await input.assertCurrent(current);
            current.throwIfAborted();
            const scope = await child.run(current);
            await input.assertCurrent(current);
            current.throwIfAborted();
            return scope;
          });
          // This continuation runs outside `running`: close can join it
          // without a cycle, including a post-open guard's own rejection.
          void running.catch(() => {
            void activity.close().catch(() => {});
          });
          return running;
        },
        close() {
          if (joined) return joined;
          joined = Promise.resolve().then(async () => {
            const results = await Promise.allSettled([child?.close()]);
            // The child close settles first/late-open; current guards then really join.
            await Promise.allSettled([running]);
            const failures = results.flatMap((result) =>
              result.status === 'rejected' ? [result.reason] : [],
            );
            if (acquisitionFailed) failures.push(acquisitionError);
            if (failures.length)
              throw Error('PRINCIPAL_CHILD_JOIN_UNKNOWN', {
                cause: new AggregateError(
                  failures,
                  'PRINCIPAL_CHILD_JOIN_FAILED',
                ),
              });
            signal.removeEventListener('abort', cancelled);
            children.delete(activity);
          });
          abort.abort();
          return joined;
        },
      };
      const cancelled = () => {
        void activity.close().catch(() => {});
      };
      children.add(activity); // Before lower acquisition; it must also be inert.
      try {
        child = input.acquire(signal);
      } catch (error) {
        acquisitionFailed = true;
        acquisitionError = error;
      }
      signal.addEventListener('abort', cancelled, { once: true });
      if (signal.aborted) cancelled();
      return activity;
    },
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(
          [...children].map((child) => child.close()),
        );
        if (results.some((r) => r.status === 'rejected'))
          throw Error('PRINCIPAL_CHILD_JOIN_UNKNOWN');
      });
      stopped.abort();
      return closing;
    },
  };
}
