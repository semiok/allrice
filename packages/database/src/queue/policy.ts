import {
  retryDelayMs,
  type JobStatus,
  type RunEventType,
} from '@allrice/contracts';

const terminalJobStatuses = new Set<JobStatus>([
  'succeeded',
  'failed',
  'dead_letter',
  'canceled',
]);

const terminalEventTypes = new Set<RunEventType>([
  'run.succeeded',
  'run.failed',
  'run.canceled',
]);

export function isTerminalJobStatus(status: JobStatus) {
  return terminalJobStatuses.has(status);
}

export function isTerminalRunEventType(type: RunEventType) {
  return terminalEventTypes.has(type);
}

export function leaseDeadline(leaseMs: number, now = new Date()) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new Error('leaseMs must be between 1000 and 300000');
  }
  return new Date(now.getTime() + leaseMs);
}

export function retryAvailableAt(
  attempt: number,
  retryBaseMs = 1_000,
  nowMs = Date.now(),
) {
  return new Date(nowMs + retryDelayMs(attempt, retryBaseMs));
}

export type MaintenanceAction =
  | 'none'
  | 'promote_retry'
  | 'cancel'
  | 'timeout'
  | 'recover_lease'
  | 'dead_letter';

/** One absolute stop cause survives clock refreshes and later cancellation. */
export function queueStopCause(
  job: {
    drain_reason?: 'cancel' | 'timeout' | null;
    cancel_requested_at: Date | null;
    timeout_at: Date;
  },
  now: Date,
) {
  if (job.drain_reason) return job.drain_reason;
  if (job.cancel_requested_at) return 'cancel' as const;
  if (job.timeout_at <= now) return 'timeout' as const;
  return null;
}

export function queueMaintenanceAction(
  job: {
    status: JobStatus;
    attempt: number;
    max_attempts: number;
    available_at: Date;
    timeout_at: Date;
    lease_expires_at: Date | null;
    cancel_requested_at: Date | null;
    drain_reason?: 'cancel' | 'timeout' | null;
  },
  now: Date,
): MaintenanceAction {
  if (isTerminalJobStatus(job.status)) return 'none';
  const stopped = queueStopCause(job, now);
  if (stopped) return stopped;
  if (job.status === 'retry_wait' && job.available_at <= now) {
    return 'promote_retry';
  }
  if (
    (job.status === 'claimed' || job.status === 'running') &&
    job.lease_expires_at &&
    job.lease_expires_at <= now
  ) {
    return job.attempt >= job.max_attempts ? 'dead_letter' : 'recover_lease';
  }
  return 'none';
}
