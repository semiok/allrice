import type { ProjectServiceStopCause } from '@allrice/contracts';

/** Persist only reviewed codes, never exception text, URLs or credentials. */
export function cloudServiceStopCause(error: unknown): ProjectServiceStopCause {
  const code = error instanceof Error ? error.message : '';
  if (code === 'CLOUD_SERVICE_CONTROL_TIMEOUT') return 'control_timeout';
  if (
    code === 'CLOUD_SERVICE_GUARD_LOST' ||
    code === 'CLOUD_SERVICE_GUARD_TIMEOUT'
  )
    return 'guard_lost';
  if (code === 'CLOUD_EXECUTION_REVOKED') return 'authority_changed';
  if (code === 'CLOUD_SERVICE_WORKER_SHUTDOWN') return 'worker_shutdown';
  if (code === 'CLOUD_SERVICE_MISSING_EXIT') return 'connection_lost';
  return 'unknown';
}

/** Share only overlapping heartbeats. No cached authority and no event merging. */
export function inFlightHeartbeat<T>(exchange: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= exchange().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
