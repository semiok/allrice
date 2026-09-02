import {
  JobSchema,
  RunEventSchema,
  RunSnapshotSchema,
  type Job,
  type JobStatus,
  type RunEvent,
  type RunEventType,
  type RunSnapshot,
  type Visibility,
} from '@allrice/contracts';

export interface JobRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  run_id: string;
  status: JobStatus;
  idempotency_key: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  available_at: Date;
  timeout_at: Date;
  payload: unknown;
  worker_id: string | null;
  lease_token: string | null;
  claimed_at: Date | null;
  heartbeat_at: Date | null;
  lease_expires_at: Date | null;
  cancel_requested_at: Date | null;
  cancel_reason: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export interface RunRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  state: RunSnapshot['status'];
  visibility: Visibility;
  policy_snapshot_id: string | null;
  execution_spec: unknown;
  input: unknown;
  result: unknown | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

export interface RunJobRow extends RunRow {
  job_id: string;
  job_status: JobStatus;
  idempotency_key: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  available_at: Date;
  timeout_at: Date;
  payload: unknown;
  worker_id: string | null;
  lease_token: string | null;
  claimed_at: Date | null;
  heartbeat_at: Date | null;
  lease_expires_at: Date | null;
  cancel_requested_at: Date | null;
  cancel_reason: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  job_created_at: Date;
  job_updated_at: Date;
  job_completed_at: Date | null;
}

export interface EventRow {
  id: string;
  run_id: string;
  sequence: number;
  event_type: RunEventType;
  schema_version: number;
  payload: unknown;
  occurred_at: Date;
}

export function mapJob(row: JobRow): Job {
  const leased =
    row.worker_id &&
    row.lease_token &&
    row.claimed_at &&
    row.heartbeat_at &&
    row.lease_expires_at
      ? {
          workerId: row.worker_id,
          token: row.lease_token,
          claimedAt: row.claimed_at.toISOString(),
          heartbeatAt: row.heartbeat_at.toISOString(),
          expiresAt: row.lease_expires_at.toISOString(),
        }
      : null;
  return JobSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    priority: row.priority,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at.toISOString(),
    timeoutAt: row.timeout_at.toISOString(),
    payload: row.payload,
    lease: leased,
  });
}

function jobFromRunRow(row: RunJobRow): JobRow {
  return {
    id: row.job_id,
    organization_id: row.organization_id,
    workspace_id: row.workspace_id,
    owner_id: row.owner_id,
    run_id: row.id,
    status: row.job_status,
    idempotency_key: row.idempotency_key,
    priority: row.priority,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    available_at: row.available_at,
    timeout_at: row.timeout_at,
    payload: row.payload,
    worker_id: row.worker_id,
    lease_token: row.lease_token,
    claimed_at: row.claimed_at,
    heartbeat_at: row.heartbeat_at,
    lease_expires_at: row.lease_expires_at,
    cancel_requested_at: row.cancel_requested_at,
    cancel_reason: row.cancel_reason,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    created_at: row.job_created_at,
    updated_at: row.job_updated_at,
    completed_at: row.job_completed_at,
  };
}

export function mapRunSnapshot(row: RunJobRow): RunSnapshot {
  return RunSnapshotSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    status: row.state,
    job: mapJob(jobFromRunRow(row)),
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    result: row.result,
    error:
      row.error_code && row.error_message
        ? { code: row.error_code, message: row.error_message }
        : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

export function mapEvent(row: EventRow): RunEvent {
  return RunEventSchema.parse({
    eventId: row.id,
    runId: row.run_id,
    sequence: row.sequence,
    type: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: row.occurred_at.toISOString(),
    payload: row.payload,
  });
}
