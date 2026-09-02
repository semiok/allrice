import { describe, expect, it } from 'vitest';

import {
  isTerminalJobStatus,
  isTerminalRunEventType,
  leaseDeadline,
  retryAvailableAt,
} from './policy.js';
import {
  mapEvent,
  mapJob,
  mapRunSnapshot,
  type EventRow,
  type JobRow,
  type RunJobRow,
} from './row-mappers.js';

const ids = {
  organization: '11111111-1111-4111-8111-111111111111',
  workspace: '22222222-2222-4222-8222-222222222222',
  owner: '33333333-3333-4333-8333-333333333333',
  run: '44444444-4444-4444-8444-444444444444',
  job: '55555555-5555-4555-8555-555555555555',
  worker: '66666666-6666-4666-8666-666666666666',
  lease: '77777777-7777-4777-8777-777777777777',
  event: '88888888-8888-4888-8888-888888888888',
} as const;

const createdAt = new Date('2026-08-05T12:00:00.000Z');
const updatedAt = new Date('2026-08-05T12:00:01.000Z');
const timeoutAt = new Date('2026-08-05T12:05:00.000Z');

function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: ids.job,
    organization_id: ids.organization,
    workspace_id: ids.workspace,
    owner_id: ids.owner,
    run_id: ids.run,
    status: 'running',
    idempotency_key: 'queue-pure-helper-test',
    priority: 1,
    attempt: 1,
    max_attempts: 3,
    available_at: createdAt,
    timeout_at: timeoutAt,
    payload: { schemaVersion: 1, type: 'test', input: { value: 1 } },
    worker_id: ids.worker,
    lease_token: ids.lease,
    claimed_at: createdAt,
    heartbeat_at: updatedAt,
    lease_expires_at: timeoutAt,
    cancel_requested_at: null,
    cancel_reason: null,
    last_error_code: null,
    last_error_message: null,
    created_at: createdAt,
    updated_at: updatedAt,
    completed_at: null,
    ...overrides,
  };
}

function runJobRow(overrides: Partial<RunJobRow> = {}): RunJobRow {
  const job = jobRow();
  return {
    id: ids.run,
    organization_id: ids.organization,
    workspace_id: ids.workspace,
    owner_id: ids.owner,
    state: 'running',
    visibility: 'private',
    policy_snapshot_id: null,
    execution_spec: {},
    input: { prompt: 'test' },
    result: null,
    error_code: null,
    error_message: null,
    created_at: createdAt,
    updated_at: updatedAt,
    started_at: createdAt,
    completed_at: null,
    job_id: job.id,
    job_status: job.status,
    idempotency_key: job.idempotency_key,
    priority: job.priority,
    attempt: job.attempt,
    max_attempts: job.max_attempts,
    available_at: job.available_at,
    timeout_at: job.timeout_at,
    payload: job.payload,
    worker_id: job.worker_id,
    lease_token: job.lease_token,
    claimed_at: job.claimed_at,
    heartbeat_at: job.heartbeat_at,
    lease_expires_at: job.lease_expires_at,
    cancel_requested_at: job.cancel_requested_at,
    cancel_reason: job.cancel_reason,
    last_error_code: job.last_error_code,
    last_error_message: job.last_error_message,
    job_created_at: job.created_at,
    job_updated_at: job.updated_at,
    job_completed_at: job.completed_at,
    ...overrides,
  };
}

describe('queue row mappers', () => {
  it('maps a leased job and drops incomplete lease tuples', () => {
    expect(mapJob(jobRow())).toMatchObject({
      id: ids.job,
      organizationId: ids.organization,
      workspaceId: ids.workspace,
      ownerId: ids.owner,
      status: 'running',
      lease: {
        workerId: ids.worker,
        token: ids.lease,
        claimedAt: createdAt.toISOString(),
        heartbeatAt: updatedAt.toISOString(),
        expiresAt: timeoutAt.toISOString(),
      },
    });
    expect(mapJob(jobRow({ heartbeat_at: null })).lease).toBeNull();
  });

  it('maps a run snapshot with its nested job and error', () => {
    expect(
      mapRunSnapshot(
        runJobRow({
          state: 'failed',
          job_status: 'failed',
          error_code: 'TEST_FAILED',
          error_message: 'test failed',
          completed_at: updatedAt,
        }),
      ),
    ).toMatchObject({
      id: ids.run,
      status: 'failed',
      job: { id: ids.job, status: 'failed' },
      error: { code: 'TEST_FAILED', message: 'test failed' },
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });
  });

  it('maps a persisted event without changing its payload', () => {
    const row: EventRow = {
      id: ids.event,
      run_id: ids.run,
      sequence: 7,
      event_type: 'tool.completed',
      schema_version: 1,
      payload: { toolCallId: 'tool-1' },
      occurred_at: updatedAt,
    };

    expect(mapEvent(row)).toEqual({
      eventId: ids.event,
      runId: ids.run,
      sequence: 7,
      type: 'tool.completed',
      schemaVersion: 1,
      occurredAt: updatedAt.toISOString(),
      payload: row.payload,
    });
  });
});

describe('queue pure policies', () => {
  it('recognizes only persisted terminal states and terminal events', () => {
    for (const status of [
      'succeeded',
      'failed',
      'dead_letter',
      'canceled',
    ] as const) {
      expect(isTerminalJobStatus(status)).toBe(true);
    }
    expect(isTerminalJobStatus('running')).toBe(false);

    for (const type of [
      'run.succeeded',
      'run.failed',
      'run.canceled',
    ] as const) {
      expect(isTerminalRunEventType(type)).toBe(true);
    }
    expect(isTerminalRunEventType('heartbeat')).toBe(false);
  });

  it('calculates lease boundaries from an explicit clock', () => {
    expect(leaseDeadline(1_000, createdAt).toISOString()).toBe(
      '2026-08-05T12:00:01.000Z',
    );
    expect(leaseDeadline(300_000, createdAt).toISOString()).toBe(
      '2026-08-05T12:05:00.000Z',
    );
    expect(createdAt.toISOString()).toBe('2026-08-05T12:00:00.000Z');
    expect(() => leaseDeadline(999, createdAt)).toThrow(
      'leaseMs must be between 1000 and 300000',
    );
    expect(() => leaseDeadline(300_001, createdAt)).toThrow(
      'leaseMs must be between 1000 and 300000',
    );
  });

  it('calculates retry availability with the contracts backoff policy', () => {
    expect(retryAvailableAt(3, 1_000, createdAt.getTime()).toISOString()).toBe(
      '2026-08-05T12:00:04.000Z',
    );
  });
});
