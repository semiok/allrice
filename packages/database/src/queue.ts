import { randomUUID } from 'node:crypto';

import {
  CancelRunInputSchema,
  ChatCitationSchema,
  CreateRunInputSchema,
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  JobPayloadSchema,
  JobSchema,
  PolicySnapshotSchema,
  RunEventSchema,
  RunEventTypeSchema,
  RunSnapshotSchema,
  UuidSchema,
  authorize,
  authorizeExecution,
  retryDelayMs,
  type ExecutionContext,
  type EmployeeExecutionSnapshot,
  type Job,
  type JobStatus,
  type RequestContext,
  type RunEvent,
  type RunEventType,
  type RunSnapshot,
  type Visibility,
} from '@allrice/contracts';
import type postgres from 'postgres';

import { DataAccessError } from './data.ts';
import { getDatabase } from './index.ts';
import { resolveWorkspaceId } from './workspace.ts';

type TransactionSql = postgres.TransactionSql;
type JsonValue = Parameters<TransactionSql['json']>[0];

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? null
    : (JSON.parse(serialized) as JsonValue);
}

interface JobRow {
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

interface RunRow {
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

interface RunJobRow extends RunRow {
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

interface EventRow {
  id: string;
  run_id: string;
  sequence: number;
  event_type: RunEventType;
  schema_version: number;
  payload: unknown;
  occurred_at: Date;
}

interface PolicyRow {
  id: string;
  organization_id: string;
  subject_id: string;
  version: number;
  payload: {
    memberships?: unknown;
    grants?: unknown;
  };
  issued_at: Date;
  expires_at: Date;
}

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

export class QueueError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'conflict'
      | 'lease_lost'
      | 'policy_denied'
      | 'cursor_invalid',
  ) {
    super(code);
  }
}

function requireUser(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

async function requireExecutionMembership(
  context: RequestContext,
  workspaceId: string,
) {
  const userId = requireUser(context);
  const permitted = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === userId &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId) &&
      (membership.role === 'admin' || membership.role === 'member'),
  );
  if (!permitted) {
    const sql = getDatabase();
    await sql`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id
      ) values (
        ${context.organizationId}, ${workspaceId}, ${userId},
        'run.enqueue', 'run', null, 'denied',
        'member_or_admin_required', ${context.requestId}
      )
    `;
    throw new DataAccessError('authorization_denied');
  }
}

function mapJob(row: JobRow): Job {
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

function mapRunSnapshot(row: RunJobRow): RunSnapshot {
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

function mapEvent(row: EventRow): RunEvent {
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

async function appendEvent(
  transaction: TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    runId: string;
    type: RunEventType;
    payload: unknown;
  },
) {
  RunEventTypeSchema.parse(input.type);
  await transaction`
    select id from allrice_runs where id = ${input.runId} for update
  `;
  const terminal = await transaction<{ terminal: boolean }[]>`
    select exists (
      select 1 from allrice_run_events
      where run_id = ${input.runId}
        and event_type in ('run.succeeded', 'run.failed', 'run.canceled')
    ) as terminal
  `;
  if (terminal[0]?.terminal) {
    throw new QueueError('conflict');
  }
  const sequences = await transaction<{ sequence: number }[]>`
    select coalesce(max(sequence), -1)::integer + 1 as sequence
    from allrice_run_events where run_id = ${input.runId}
  `;
  const sequence = sequences[0]?.sequence ?? 0;
  const rows = await transaction<EventRow[]>`
    insert into allrice_run_events (
      organization_id, workspace_id, run_id, sequence, event_type, payload
    ) values (
      ${input.organizationId}, ${input.workspaceId}, ${input.runId},
      ${sequence}, ${input.type}, ${transaction.json(toJsonValue(input.payload))}
    )
    returning *
  `;
  const event = rows[0];
  if (!event) throw new Error('run event creation failed');
  await transaction`
    insert into allrice_employee_run_steps (
      organization_id, workspace_id, run_id, sequence, event_type, payload,
      occurred_at
    )
    select ${input.organizationId}, ${input.workspaceId}, ${input.runId},
      ${sequence}, ${input.type},
      ${transaction.json(toJsonValue(input.payload))}, ${event.occurred_at}
    where exists (
      select 1 from allrice_employee_runs where run_id = ${input.runId}
    )
    on conflict (run_id, sequence) do nothing
  `;
  return mapEvent(event);
}

async function audit(
  transaction: TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    actorId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    decision: 'allowed' | 'denied' | 'recorded';
    reason: string;
    requestId: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await transaction`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${input.organizationId}, ${input.workspaceId}, ${input.actorId},
      ${input.action}, ${input.resourceType}, ${input.resourceId},
      ${input.decision}, ${input.reason}, ${input.requestId},
      ${transaction.json(toJsonValue(input.metadata ?? {}))}
    )
  `;
}

async function selectRunJob(
  organizationId: string,
  workspaceId: string,
  runId: string,
) {
  const sql = getDatabase();
  const rows = await sql<RunJobRow[]>`
    select
      r.*,
      j.id as job_id, j.status as job_status, j.idempotency_key,
      j.priority, j.attempt, j.max_attempts, j.available_at, j.timeout_at,
      j.payload, j.worker_id, j.lease_token, j.claimed_at, j.heartbeat_at,
      j.lease_expires_at, j.cancel_requested_at, j.cancel_reason,
      j.last_error_code, j.last_error_message,
      j.created_at as job_created_at, j.updated_at as job_updated_at,
      j.completed_at as job_completed_at
    from allrice_runs r
    join allrice_jobs j on j.run_id = r.id
    where r.id = ${UuidSchema.parse(runId)}
      and r.organization_id = ${organizationId}
      and r.workspace_id = ${workspaceId}
  `;
  return rows[0];
}

function authorizeRun(context: RequestContext, row: RunRow) {
  const decision = authorize(
    {
      type: 'run',
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      visibility: row.visibility,
      archivedAt: null,
    },
    'resource:read',
    context,
  );
  if (!decision.allowed) throw new QueueError('not_found');
}

export async function enqueueRun(
  context: RequestContext,
  input: unknown,
  options: {
    skillBinding?: {
      installationId: string;
      skillVersionId: string;
      providerSnapshot: Record<string, unknown>;
    };
    employeeBinding?: {
      employeeAssignmentId: string;
      employeeVersionId: string;
      sessionId: string;
      userMessageId: string;
      assistantMessageId: string;
      providerSnapshot: Record<string, unknown>;
      skillVersionIds: string[];
      skillBindings: unknown[];
      nativeSkills: unknown[];
      promptSnapshot: Record<string, unknown>;
      executionSnapshot: Omit<
        Extract<EmployeeExecutionSnapshot, { schemaVersion: 2 }>,
        'tenantContext' | 'createdAt'
      >;
    };
    conversationDelivery?: {
      sessionId: string;
      userMessageId: string;
      assistantMessageId: string;
      clientUserMessageId: string;
      message: string;
      requestedMode: 'auto' | 'steer' | 'follow_up';
      expectedTurnId?: string;
      expectedGeneration?: number;
      hasAttachments: boolean;
    };
    workflowBinding?: {
      employeeId: string;
      workflowRevisionId: string;
      sessionId: string | null;
    };
  } = {},
) {
  const submission = CreateRunInputSchema.parse(input);
  const ownerId = requireUser(context);
  const workspaceId = await resolveWorkspaceId(context, submission.workspaceId);
  await requireExecutionMembership(context, workspaceId);
  let availableAt = submission.availableAt
    ? new Date(submission.availableAt)
    : new Date();
  let timeoutAt = new Date(
    Math.max(Date.now(), availableAt.getTime()) + submission.timeoutMs,
  );
  const sql = getDatabase();
  const result = await sql.begin(async (transaction) => {
    await transaction`
      select pg_advisory_xact_lock(
        hashtextextended(${`${context.organizationId}:${submission.idempotencyKey}`}, 0)
      )
    `;
    const existing = await transaction<
      {
        run_id: string;
        workspace_id: string;
        owner_id: string;
        payload: { type?: unknown; input?: unknown };
      }[]
    >`
      select run_id, workspace_id, owner_id, payload from allrice_jobs
      where organization_id = ${context.organizationId}
        and idempotency_key = ${submission.idempotencyKey}
    `;
    if (existing[0]) {
      if (
        existing[0].workspace_id !== workspaceId ||
        existing[0].owner_id !== ownerId ||
        existing[0].payload.type !== submission.type ||
        JSON.stringify(existing[0].payload.input) !==
          JSON.stringify(submission.input)
      ) {
        throw new QueueError('conflict');
      }
      return {
        runId: existing[0].run_id,
        created: false,
        delivery: 'immediate' as const,
        activeRunId: null as string | null,
      };
    }

    let delivery: 'immediate' | 'follow_up' | 'steer_pending' = 'immediate';
    let activeRunId: string | null = null;
    let expectedTurnId: string | null = null;
    let expectedGeneration: number | null = null;
    if (options.conversationDelivery) {
      const runtimeRows = await transaction<
        {
          state: string;
          active_run_id: string | null;
          active_turn_id: string | null;
          thread_generation: number;
        }[]
      >`
        select state, active_run_id, active_turn_id, thread_generation
        from allrice_conversation_runtimes
        where organization_id = ${context.organizationId}
          and workspace_id = ${workspaceId}
          and session_id = ${options.conversationDelivery.sessionId}
          and owner_id = ${ownerId}
        for update
      `;
      const runtime = runtimeRows[0];
      if (runtime?.state === 'running' && runtime.active_run_id) {
        activeRunId = runtime.active_run_id;
        const exactTurn =
          !options.conversationDelivery.hasAttachments &&
          options.conversationDelivery.requestedMode !== 'follow_up' &&
          runtime.active_turn_id !== null &&
          options.conversationDelivery.expectedTurnId ===
            runtime.active_turn_id &&
          options.conversationDelivery.expectedGeneration ===
            runtime.thread_generation;
        delivery = exactTurn ? 'steer_pending' : 'follow_up';
        expectedTurnId = exactTurn ? runtime.active_turn_id : null;
        expectedGeneration = exactTurn ? runtime.thread_generation : null;
        availableAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        timeoutAt = new Date(availableAt.getTime() + submission.timeoutMs);
      }
    }
    const policyExpiresAt = new Date(timeoutAt.getTime() + 24 * 60 * 60 * 1000);

    await transaction`select id from allrice_users where id = ${ownerId} for update`;
    const versions = await transaction<{ version: number }[]>`
      select coalesce(max(version), 0)::integer + 1 as version
      from allrice_policy_snapshots
      where organization_id = ${context.organizationId}
        and subject_id = ${ownerId}
    `;
    const policyVersion = versions[0]?.version ?? 1;
    const policies = await transaction<{ id: string }[]>`
      insert into allrice_policy_snapshots (
        organization_id, subject_id, version, payload, expires_at
      ) values (
        ${context.organizationId}, ${ownerId}, ${policyVersion},
        ${transaction.json(
          toJsonValue({
            memberships: context.memberships.filter(
              (membership) =>
                membership.organizationId === context.organizationId &&
                (membership.workspaceId === null ||
                  membership.workspaceId === workspaceId),
            ),
            grants: [
              {
                resourceType: 'job',
                action: 'job:execute',
                workspaceId,
              },
              ...(options.employeeBinding
                ? ['storage_object', 'memory', 'chat_session'].map(
                    (resourceType) => ({
                      resourceType,
                      action: 'resource:read' as const,
                      workspaceId,
                    }),
                  )
                : []),
              ...(options.employeeBinding
                ? [
                    {
                      resourceType: 'automation',
                      action: 'resource:write' as const,
                      workspaceId,
                    },
                  ]
                : []),
              ...(options.workflowBinding
                ? ['storage_object', 'memory', 'chat_session'].map(
                    (resourceType) => ({
                      resourceType,
                      action: 'resource:read' as const,
                      workspaceId,
                    }),
                  )
                : []),
            ],
          }),
        )},
        ${policyExpiresAt}
      )
      returning id
    `;
    const policy = policies[0];
    if (!policy) throw new Error('policy snapshot creation failed');
    const payload = JobPayloadSchema.parse({
      schemaVersion: 1,
      type: submission.type,
      input: submission.input,
    });
    const runs = await transaction<{ id: string }[]>`
      insert into allrice_runs (
        organization_id, workspace_id, owner_id, state, visibility,
        policy_snapshot_id, execution_spec, input, request_id
      ) values (
        ${context.organizationId}, ${workspaceId}, ${ownerId}, 'queued', 'private',
        ${policy.id},
        ${transaction.json(
          toJsonValue({
            schemaVersion: 1,
            handler: submission.type,
            employeeVersionId:
              options.employeeBinding?.employeeVersionId ?? null,
            skillVersionId: options.skillBinding?.skillVersionId ?? null,
            provider:
              options.skillBinding || options.employeeBinding ? 'codex' : null,
            skillVersionIds:
              options.employeeBinding?.skillVersionIds ?? undefined,
            workflowRevisionId:
              options.workflowBinding?.workflowRevisionId ?? undefined,
            employeeId: options.workflowBinding?.employeeId ?? undefined,
          }),
        )},
        ${transaction.json(toJsonValue(submission.input))}, ${context.requestId}
      )
      returning id
    `;
    const run = runs[0];
    if (!run) throw new Error('run creation failed');
    const jobs = await transaction<{ id: string }[]>`
      insert into allrice_jobs (
        organization_id, workspace_id, owner_id, run_id, status,
        idempotency_key, priority, max_attempts, available_at, timeout_at, payload
      ) values (
        ${context.organizationId}, ${workspaceId}, ${ownerId}, ${run.id}, 'queued',
        ${submission.idempotencyKey}, ${submission.priority},
        ${submission.maxAttempts}, ${availableAt}, ${timeoutAt},
        ${transaction.json(toJsonValue(payload))}
      )
      returning id
    `;
    const job = jobs[0];
    if (!job) throw new Error('job creation failed');
    if (options.conversationDelivery && delivery !== 'immediate') {
      await transaction`
        insert into allrice_conversation_followups (
          run_id, organization_id, workspace_id, session_id, owner_id,
          user_message_id, assistant_message_id, client_user_message_id,
          mode, state
        ) values (
          ${run.id}, ${context.organizationId}, ${workspaceId},
          ${options.conversationDelivery.sessionId}, ${ownerId},
          ${options.conversationDelivery.userMessageId},
          ${options.conversationDelivery.assistantMessageId},
          ${options.conversationDelivery.clientUserMessageId},
          ${delivery === 'steer_pending' ? 'steer_fallback' : 'follow_up'},
          'queued'
        )
      `;
      if (
        delivery === 'steer_pending' &&
        expectedTurnId !== null &&
        expectedGeneration !== null
      ) {
        await transaction`
          insert into allrice_conversation_commands (
            organization_id, workspace_id, session_id, owner_id,
            followup_run_id, command_type, client_user_message_id,
            expected_generation, expected_turn_id, message
          ) values (
            ${context.organizationId}, ${workspaceId},
            ${options.conversationDelivery.sessionId}, ${ownerId}, ${run.id},
            'steer', ${options.conversationDelivery.clientUserMessageId},
            ${expectedGeneration}, ${expectedTurnId},
            ${options.conversationDelivery.message}
          )
        `;
      }
    }
    if (options.skillBinding) {
      await transaction`
        insert into allrice_skill_runs (
          run_id, organization_id, workspace_id, installation_id,
          skill_version_id, provider, provider_snapshot
        ) values (
          ${run.id}, ${context.organizationId}, ${workspaceId},
          ${options.skillBinding.installationId},
          ${options.skillBinding.skillVersionId}, 'codex',
          ${transaction.json(
            toJsonValue(options.skillBinding.providerSnapshot),
          )}
        )
      `;
    }
    if (options.employeeBinding) {
      const executionSnapshot = EmployeeExecutionSnapshotSchema.parse({
        ...options.employeeBinding.executionSnapshot,
        tenantContext: {
          organizationId: context.organizationId,
          workspaceId,
          actorId: ownerId,
          policySnapshotId: policy.id,
        },
        createdAt: new Date().toISOString(),
      });
      await transaction`
        insert into allrice_employee_runs (
          run_id, organization_id, workspace_id, owner_id,
          employee_assignment_id, employee_version_id, session_id,
          user_message_id, assistant_message_id, status, provider_snapshot,
          skill_bindings, native_skills, prompt_snapshot, execution_snapshot,
          created_at
        ) values (
          ${run.id}, ${context.organizationId}, ${workspaceId}, ${ownerId},
          ${options.employeeBinding.employeeAssignmentId},
          ${options.employeeBinding.employeeVersionId},
          ${options.employeeBinding.sessionId},
          ${options.employeeBinding.userMessageId},
          ${options.employeeBinding.assistantMessageId}, 'queued',
          ${transaction.json(
            toJsonValue(options.employeeBinding.providerSnapshot),
          )},
          ${transaction.json(toJsonValue(options.employeeBinding.skillBindings))},
          ${transaction.json(toJsonValue(options.employeeBinding.nativeSkills))},
          ${transaction.json(toJsonValue(options.employeeBinding.promptSnapshot))},
          ${transaction.json(toJsonValue(executionSnapshot))},
          ${executionSnapshot.createdAt}
        )
      `;
    }
    await appendEvent(transaction, {
      organizationId: context.organizationId,
      workspaceId,
      runId: run.id,
      type: 'run.created',
      payload: {
        jobId: job.id,
        status: 'queued',
        availableAt: availableAt.toISOString(),
      },
    });
    await audit(transaction, {
      organizationId: context.organizationId,
      workspaceId,
      actorId: ownerId,
      action: 'run.enqueue',
      resourceType: 'run',
      resourceId: run.id,
      decision: 'allowed',
      reason: 'frozen_policy_snapshot',
      requestId: context.requestId,
      metadata: { jobId: job.id, policySnapshotId: policy.id },
    });
    return { runId: run.id, created: true, delivery, activeRunId };
  });
  return {
    run: await getRun(context, workspaceId, result.runId),
    created: result.created,
    delivery: result.delivery,
    activeRunId: result.activeRunId,
  };
}

export async function getRun(
  context: RequestContext,
  workspaceIdInput: string,
  runId: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const row = await selectRunJob(context.organizationId, workspaceId, runId);
  if (!row) throw new QueueError('not_found');
  authorizeRun(context, row);
  return mapRunSnapshot(row);
}

export async function listRunEvents(
  context: RequestContext,
  workspaceIdInput: string,
  runId: string,
  afterSequence = -1,
) {
  const run = await getRun(context, workspaceIdInput, runId);
  if (!Number.isInteger(afterSequence) || afterSequence < -1) {
    throw new QueueError('cursor_invalid');
  }
  const sql = getDatabase();
  const rows = await sql<EventRow[]>`
    select * from allrice_run_events
    where organization_id = ${context.organizationId}
      and workspace_id = ${run.workspaceId}
      and run_id = ${run.id}
      and sequence > ${afterSequence}
    order by sequence
  `;
  return rows.map(mapEvent);
}

export async function cancelRun(
  context: RequestContext,
  workspaceIdInput: string,
  runId: string,
  input: unknown,
) {
  const cancellation = CancelRunInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const snapshot = await getRun(context, workspaceId, runId);
  if (snapshot.ownerId !== requireUser(context)) {
    throw new QueueError('not_found');
  }
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const rows = await transaction<JobRow[]>`
      select * from allrice_jobs where run_id = ${snapshot.id} for update
    `;
    const job = rows[0];
    if (!job) throw new QueueError('not_found');
    if (job.status === 'canceled') return;
    if (terminalJobStatuses.has(job.status)) throw new QueueError('conflict');
    await transaction`
      update allrice_jobs
      set cancel_requested_at = coalesce(cancel_requested_at, now()),
          cancel_reason = ${cancellation.reason}, updated_at = now()
      where id = ${job.id}
    `;
    await audit(transaction, {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      actorId: requireUser(context),
      action: 'run.cancel.request',
      resourceType: 'run',
      resourceId: snapshot.id,
      decision: 'allowed',
      reason: cancellation.reason,
      requestId: context.requestId,
      metadata: { jobId: job.id, status: job.status },
    });
  });
  return getRun(context, workspaceId, runId);
}

function leaseDeadline(leaseMs: number, now = new Date()) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new Error('leaseMs must be between 1000 and 300000');
  }
  return new Date(now.getTime() + leaseMs);
}

export async function claimNextJob(workerIdInput: string, leaseMs: number) {
  const workerId = UuidSchema.parse(workerIdInput);
  const leaseToken = randomUUID();
  const now = new Date();
  const expiresAt = leaseDeadline(leaseMs, now);
  const sql = getDatabase();
  const row = await sql.begin(async (transaction) => {
    const rows = await transaction<JobRow[]>`
      select candidate.* from allrice_jobs candidate
      where candidate.status = 'queued'
        and candidate.available_at <= ${now}
        and candidate.timeout_at > ${now}
        and candidate.cancel_requested_at is null
      order by (
        select count(*) from allrice_jobs active
        where active.organization_id = candidate.organization_id
          and active.status in ('claimed', 'running', 'waiting_approval')
      ) asc,
      candidate.priority desc, candidate.available_at,
      candidate.created_at, candidate.id
      for update skip locked
      limit 1
    `;
    const job = rows[0];
    if (!job) return null;
    const claimed = await transaction<JobRow[]>`
      update allrice_jobs
      set status = 'claimed', attempt = attempt + 1,
          worker_id = ${workerId}, lease_token = ${leaseToken},
          claimed_at = ${now}, heartbeat_at = ${now},
          lease_expires_at = ${expiresAt}, updated_at = ${now}
      where id = ${job.id}
      returning *
    `;
    return claimed[0] ?? null;
  });
  return row ? mapJob(row) : null;
}

async function transitionTerminal(
  transaction: TransactionSql,
  job: JobRow,
  input: {
    jobStatus: 'failed' | 'dead_letter' | 'canceled' | 'succeeded';
    runStatus: 'failed' | 'canceled' | 'succeeded';
    eventType: 'run.failed' | 'run.canceled' | 'run.succeeded';
    code?: string;
    message?: string;
    result?: unknown;
    payload: Record<string, unknown>;
  },
) {
  await transaction`
    update allrice_jobs
    set status = ${input.jobStatus}, worker_id = null, lease_token = null,
        claimed_at = null, heartbeat_at = null, lease_expires_at = null,
        last_error_code = ${input.code ?? null},
        last_error_message = ${input.message ?? null},
        updated_at = now(), completed_at = now()
    where id = ${job.id}
  `;
  await transaction`
    update allrice_runs
    set state = ${input.runStatus}, result = ${
      input.result === undefined
        ? null
        : transaction.json(toJsonValue(input.result))
    }, error_code = ${input.code ?? null}, error_message = ${
      input.message ?? null
    }, updated_at = now(), completed_at = now()
    where id = ${job.run_id}
  `;
  await transaction`
    update allrice_conversation_followups
    set state = ${input.runStatus === 'succeeded' ? 'consumed' : 'canceled'},
        consumed_at = ${input.runStatus === 'succeeded' ? new Date() : null}
    where run_id = ${job.run_id} and state in ('released', 'running')
  `;
  const employeeRuns = await transaction<
    { assistant_message_id: string; prompt_snapshot: unknown }[]
  >`
    update allrice_employee_runs
    set status = ${input.runStatus}, error_code = ${input.code ?? null},
        error_message = ${input.message ?? null}, completed_at = now()
    where run_id = ${job.run_id}
    returning assistant_message_id, prompt_snapshot
  `;
  const employeeRun = employeeRuns[0];
  if (employeeRun) {
    const result =
      input.result && typeof input.result === 'object'
        ? (input.result as Record<string, unknown>)
        : {};
    const prompt =
      employeeRun.prompt_snapshot &&
      typeof employeeRun.prompt_snapshot === 'object'
        ? (employeeRun.prompt_snapshot as Record<string, unknown>)
        : {};
    const memories = Array.isArray(prompt.memories) ? prompt.memories : [];
    const memoryCitations = memories.flatMap((memory) => {
      if (!memory || typeof memory !== 'object') return [];
      const item = memory as Record<string, unknown>;
      return typeof item.id === 'string' && typeof item.content === 'string'
        ? [
            {
              type: 'memory',
              id: item.id,
              label: item.content.slice(0, 120),
            },
          ]
        : [];
    });
    const executionCitations = Array.isArray(result.citations)
      ? result.citations.flatMap((citation) => {
          const parsed = ChatCitationSchema.safeParse(citation);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    const citations = [...executionCitations, ...memoryCitations].filter(
      (citation, index, values) =>
        values.findIndex(
          (candidate) =>
            candidate.type === citation.type && candidate.id === citation.id,
        ) === index,
    );
    const failureText =
      input.code === 'SKILL_ARTIFACT_MISSING'
        ? 'Rice 暂时无法使用已引用的 Skill：Skill 文件在本地存储中缺失。请重新安装或刷新该 Skill 后重试。'
        : input.code === 'SKILL_ARTIFACT_MISMATCH' ||
            input.code === 'SKILL_ARTIFACT_INVALID'
          ? 'Rice 暂时无法使用已引用的 Skill：Skill 文件校验失败。请重新安装或刷新该 Skill 后重试。'
          : 'Rice 暂时无法完成这次请求，请稍后重试。';
    const text =
      input.runStatus === 'succeeded' && typeof result.answer === 'string'
        ? result.answer
        : input.runStatus === 'canceled'
          ? 'Rice 的这次执行已取消。'
          : failureText;
    await transaction`
      update allrice_messages
      set content = ${transaction.json(toJsonValue({ text, citations }))},
          status = ${input.runStatus === 'succeeded' ? 'completed' : 'failed'},
          error_code = ${input.code ?? null}, completed_at = now()
      where id = ${employeeRun.assistant_message_id}
    `;
  }
  await appendEvent(transaction, {
    organizationId: job.organization_id,
    workspaceId: job.workspace_id,
    runId: job.run_id,
    type: input.eventType,
    payload: input.payload,
  });
}

export interface ClaimedExecution {
  context: ExecutionContext;
  job: Job;
  payload: ReturnType<typeof JobPayloadSchema.parse>;
}

export async function startClaimedJob(
  workerIdInput: string,
  jobIdInput: string,
  leaseTokenInput: string,
): Promise<ClaimedExecution | null> {
  const workerId = UuidSchema.parse(workerIdInput);
  const jobId = UuidSchema.parse(jobIdInput);
  const leaseToken = UuidSchema.parse(leaseTokenInput);
  const now = new Date();
  const sql = getDatabase();
  const result = await sql.begin(async (transaction) => {
    const jobs = await transaction<JobRow[]>`
      select * from allrice_jobs where id = ${jobId} for update
    `;
    const job = jobs[0];
    if (
      !job ||
      job.status !== 'claimed' ||
      job.worker_id !== workerId ||
      job.lease_token !== leaseToken ||
      !job.lease_expires_at ||
      job.lease_expires_at <= now
    ) {
      throw new QueueError('lease_lost');
    }
    if (job.cancel_requested_at) {
      await transitionTerminal(transaction, job, {
        jobStatus: 'canceled',
        runStatus: 'canceled',
        eventType: 'run.canceled',
        payload: { reason: job.cancel_reason ?? 'user_requested' },
      });
      return { execution: null, denied: false };
    }
    if (job.timeout_at <= now) {
      await transitionTerminal(transaction, job, {
        jobStatus: 'failed',
        runStatus: 'failed',
        eventType: 'run.failed',
        code: 'JOB_TIMEOUT',
        message: 'Job timed out before execution started',
        payload: { code: 'JOB_TIMEOUT' },
      });
      return { execution: null, denied: false };
    }
    const policies = await transaction<PolicyRow[]>`
      select p.*
      from allrice_policy_snapshots p
      join allrice_runs r on r.policy_snapshot_id = p.id
      where r.id = ${job.run_id}
    `;
    const policy = policies[0];
    if (!policy) throw new Error('run policy snapshot missing');
    const policySnapshot = PolicySnapshotSchema.parse({
      id: policy.id,
      organizationId: policy.organization_id,
      subjectId: policy.subject_id,
      version: policy.version,
      issuedAt: policy.issued_at.toISOString(),
      expiresAt: policy.expires_at.toISOString(),
      memberships: policy.payload.memberships ?? [],
      grants: policy.payload.grants ?? [],
    });
    const context = ExecutionContextSchema.parse({
      executionId: randomUUID(),
      runId: job.run_id,
      jobId: job.id,
      worker: { type: 'worker', id: workerId },
      delegatedBy: { type: 'user', id: job.owner_id },
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      policySnapshot,
      startedAt: now.toISOString(),
    });
    const decision = authorizeExecution(
      {
        type: 'job',
        id: job.id,
        organizationId: job.organization_id,
        workspaceId: job.workspace_id,
        ownerId: job.owner_id,
        visibility: 'private',
        archivedAt: null,
      },
      'job:execute',
      context,
      now,
    );
    if (!decision.allowed) {
      await transitionTerminal(transaction, job, {
        jobStatus: 'dead_letter',
        runStatus: 'failed',
        eventType: 'run.failed',
        code: 'POLICY_DENIED',
        message: 'Frozen policy denied Worker execution',
        payload: { code: 'POLICY_DENIED', reason: decision.reason },
      });
      await audit(transaction, {
        organizationId: job.organization_id,
        workspaceId: job.workspace_id,
        actorId: null,
        action: 'job.execute',
        resourceType: 'job',
        resourceId: job.id,
        decision: 'denied',
        reason: decision.reason,
        requestId: null,
        metadata: { workerId },
      });
      return { execution: null, denied: true };
    }
    const updated = await transaction<JobRow[]>`
      update allrice_jobs set status = 'running', updated_at = now()
      where id = ${job.id}
      returning *
    `;
    await transaction`
      update allrice_runs
      set state = 'running', started_at = coalesce(started_at, now()),
          updated_at = now()
      where id = ${job.run_id}
    `;
    await transaction`
      update allrice_employee_runs
      set status = 'running', started_at = coalesce(started_at, now())
      where run_id = ${job.run_id}
    `;
    await appendEvent(transaction, {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      runId: job.run_id,
      type: 'run.started',
      payload: { jobId: job.id, workerId, attempt: job.attempt },
    });
    await audit(transaction, {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      actorId: null,
      action: 'job.execute',
      resourceType: 'job',
      resourceId: job.id,
      decision: 'allowed',
      reason: decision.reason,
      requestId: null,
      metadata: { runId: job.run_id, attempt: job.attempt, workerId },
    });
    const running = updated[0];
    if (!running) throw new Error('job start failed');
    return {
      execution: {
        context,
        job: mapJob(running),
        payload: JobPayloadSchema.parse(running.payload),
      },
      denied: false,
    };
  });
  if (result.denied) throw new QueueError('policy_denied');
  return result.execution;
}

async function lockedLeasedJob(
  transaction: TransactionSql,
  workerId: string,
  jobId: string,
  leaseToken: string,
) {
  const rows = await transaction<JobRow[]>`
    select * from allrice_jobs where id = ${jobId} for update
  `;
  const job = rows[0];
  if (
    !job ||
    job.status !== 'running' ||
    job.worker_id !== workerId ||
    job.lease_token !== leaseToken ||
    !job.lease_expires_at ||
    job.lease_expires_at <= new Date()
  ) {
    throw new QueueError('lease_lost');
  }
  return job;
}

export async function heartbeatJob(
  workerIdInput: string,
  jobIdInput: string,
  leaseTokenInput: string,
  leaseMs: number,
) {
  const workerId = UuidSchema.parse(workerIdInput);
  const jobId = UuidSchema.parse(jobIdInput);
  const leaseToken = UuidSchema.parse(leaseTokenInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const job = await lockedLeasedJob(transaction, workerId, jobId, leaseToken);
    if (job.cancel_requested_at) {
      await transitionTerminal(transaction, job, {
        jobStatus: 'canceled',
        runStatus: 'canceled',
        eventType: 'run.canceled',
        payload: { reason: job.cancel_reason ?? 'user_requested' },
      });
      return { active: false, canceled: true };
    }
    if (job.timeout_at <= new Date()) {
      await transitionTerminal(transaction, job, {
        jobStatus: 'failed',
        runStatus: 'failed',
        eventType: 'run.failed',
        code: 'JOB_TIMEOUT',
        message: 'Job execution timed out',
        payload: { code: 'JOB_TIMEOUT' },
      });
      return { active: false, canceled: false };
    }
    const now = new Date();
    await transaction`
      update allrice_jobs
      set heartbeat_at = ${now}, lease_expires_at = ${leaseDeadline(leaseMs, now)},
          updated_at = ${now}
      where id = ${job.id}
    `;
    return { active: true, canceled: false };
  });
}

export async function appendJobEvent(input: {
  workerId: string;
  jobId: string;
  leaseToken: string;
  type: RunEventType;
  payload: unknown;
}) {
  if (terminalEventTypes.has(input.type)) throw new QueueError('conflict');
  const workerId = UuidSchema.parse(input.workerId);
  const jobId = UuidSchema.parse(input.jobId);
  const leaseToken = UuidSchema.parse(input.leaseToken);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const job = await lockedLeasedJob(transaction, workerId, jobId, leaseToken);
    return appendEvent(transaction, {
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
      runId: job.run_id,
      type: input.type,
      payload: input.payload,
    });
  });
}

export async function completeJob(input: {
  workerId: string;
  jobId: string;
  leaseToken: string;
  result: unknown;
}) {
  const workerId = UuidSchema.parse(input.workerId);
  const jobId = UuidSchema.parse(input.jobId);
  const leaseToken = UuidSchema.parse(input.leaseToken);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const job = await lockedLeasedJob(transaction, workerId, jobId, leaseToken);
    if (job.cancel_requested_at) {
      await transitionTerminal(transaction, job, {
        jobStatus: 'canceled',
        runStatus: 'canceled',
        eventType: 'run.canceled',
        payload: { reason: job.cancel_reason ?? 'user_requested' },
      });
      return;
    }
    await transitionTerminal(transaction, job, {
      jobStatus: 'succeeded',
      runStatus: 'succeeded',
      eventType: 'run.succeeded',
      result: input.result,
      payload: { result: input.result },
    });
  });
}

export async function failJob(input: {
  workerId: string;
  jobId: string;
  leaseToken: string;
  code: string;
  message: string;
  retryable: boolean;
  retryBaseMs?: number;
}) {
  const workerId = UuidSchema.parse(input.workerId);
  const jobId = UuidSchema.parse(input.jobId);
  const leaseToken = UuidSchema.parse(input.leaseToken);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const job = await lockedLeasedJob(transaction, workerId, jobId, leaseToken);
    if (job.cancel_requested_at) {
      await transitionTerminal(transaction, job, {
        jobStatus: 'canceled',
        runStatus: 'canceled',
        eventType: 'run.canceled',
        payload: { reason: job.cancel_reason ?? 'user_requested' },
      });
      return { retrying: false };
    }
    const canRetry =
      input.retryable &&
      job.attempt < job.max_attempts &&
      job.timeout_at > new Date();
    if (canRetry) {
      const delayMs = retryDelayMs(job.attempt, input.retryBaseMs ?? 1_000);
      const availableAt = new Date(Date.now() + delayMs);
      await transaction`
        update allrice_jobs
        set status = 'retry_wait', available_at = ${availableAt},
            worker_id = null, lease_token = null, claimed_at = null,
            heartbeat_at = null, lease_expires_at = null,
            last_error_code = ${input.code}, last_error_message = ${input.message},
            updated_at = now()
        where id = ${job.id}
      `;
      await transaction`
        update allrice_runs set state = 'queued', updated_at = now()
        where id = ${job.run_id}
      `;
      await transaction`
        update allrice_employee_runs set status = 'queued'
        where run_id = ${job.run_id}
      `;
      await appendEvent(transaction, {
        organizationId: job.organization_id,
        workspaceId: job.workspace_id,
        runId: job.run_id,
        type: 'run.retrying',
        payload: {
          outcome: 'retry_scheduled',
          code: input.code,
          attempt: job.attempt,
          availableAt: availableAt.toISOString(),
        },
      });
      return { retrying: true, availableAt: availableAt.toISOString() };
    }
    const deadLetter = input.retryable && job.attempt >= job.max_attempts;
    await transitionTerminal(transaction, job, {
      jobStatus: deadLetter ? 'dead_letter' : 'failed',
      runStatus: 'failed',
      eventType: 'run.failed',
      code: input.code,
      message: input.message,
      payload: {
        code: input.code,
        message: input.message,
        attempt: job.attempt,
        deadLetter,
      },
    });
    return { retrying: false };
  });
}

export type MaintenanceAction =
  | 'none'
  | 'promote_retry'
  | 'cancel'
  | 'timeout'
  | 'recover_lease'
  | 'dead_letter';

export function queueMaintenanceAction(
  job: Pick<
    JobRow,
    | 'status'
    | 'attempt'
    | 'max_attempts'
    | 'available_at'
    | 'timeout_at'
    | 'lease_expires_at'
    | 'cancel_requested_at'
  >,
  now: Date,
): MaintenanceAction {
  if (terminalJobStatuses.has(job.status)) return 'none';
  if (job.cancel_requested_at) return 'cancel';
  if (job.timeout_at <= now) return 'timeout';
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

export async function maintainQueue(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('maintenance limit must be between 1 and 1000');
  }
  const now = new Date();
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const rows = await transaction<JobRow[]>`
      select * from allrice_jobs
      where status in ('queued', 'claimed', 'running', 'retry_wait')
        and (
          cancel_requested_at is not null
          or timeout_at <= ${now}
          or (status = 'retry_wait' and available_at <= ${now})
          or (status in ('claimed', 'running') and lease_expires_at <= ${now})
        )
      order by updated_at, id
      for update skip locked
      limit ${limit}
    `;
    const counts: Record<Exclude<MaintenanceAction, 'none'>, number> = {
      promote_retry: 0,
      cancel: 0,
      timeout: 0,
      recover_lease: 0,
      dead_letter: 0,
    };
    for (const job of rows) {
      const action = queueMaintenanceAction(job, now);
      if (action === 'none') continue;
      counts[action] += 1;
      if (action === 'promote_retry') {
        await transaction`
          update allrice_jobs set status = 'queued', updated_at = ${now}
          where id = ${job.id}
        `;
        continue;
      }
      if (action === 'cancel') {
        await transitionTerminal(transaction, job, {
          jobStatus: 'canceled',
          runStatus: 'canceled',
          eventType: 'run.canceled',
          payload: { reason: job.cancel_reason ?? 'user_requested' },
        });
        continue;
      }
      if (action === 'timeout') {
        await transitionTerminal(transaction, job, {
          jobStatus: 'failed',
          runStatus: 'failed',
          eventType: 'run.failed',
          code: 'JOB_TIMEOUT',
          message: 'Job execution timed out',
          payload: { code: 'JOB_TIMEOUT', attempt: job.attempt },
        });
        continue;
      }
      if (action === 'dead_letter') {
        await transitionTerminal(transaction, job, {
          jobStatus: 'dead_letter',
          runStatus: 'failed',
          eventType: 'run.failed',
          code: 'LEASE_EXHAUSTED',
          message: 'Worker lease expired after the final attempt',
          payload: { code: 'LEASE_EXHAUSTED', attempt: job.attempt },
        });
        continue;
      }
      await transaction`
        update allrice_jobs
        set status = 'queued', worker_id = null, lease_token = null,
            claimed_at = null, heartbeat_at = null, lease_expires_at = null,
            available_at = ${now}, updated_at = ${now}
        where id = ${job.id}
      `;
      await transaction`
        update allrice_runs set state = 'queued', updated_at = ${now}
        where id = ${job.run_id}
      `;
      await transaction`
        update allrice_employee_runs set status = 'queued'
        where run_id = ${job.run_id}
      `;
      await appendEvent(transaction, {
        organizationId: job.organization_id,
        workspaceId: job.workspace_id,
        runId: job.run_id,
        type: 'heartbeat',
        payload: {
          kind: 'lease.recovered',
          previousWorkerId: job.worker_id,
          attempt: job.attempt,
        },
      });
    }
    return counts;
  });
}

export async function queueSummary() {
  const sql = getDatabase();
  const rows = await sql<{ status: JobStatus; count: number | string }[]>`
    select status, count(*)::bigint as count
    from allrice_jobs
    where status not in ('succeeded', 'failed', 'dead_letter', 'canceled')
    group by status
  `;
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}
