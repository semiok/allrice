import { randomUUID } from 'node:crypto';

import {
  CancelRunInputSchema,
  ChatCitationSchema,
  ChatMessageContentSchema,
  CreateRunInputSchema,
  EmployeeExecutionSnapshotSchema,
  ExecutionContextSchema,
  JobPayloadSchema,
  PolicySnapshotSchema,
  RunEventTypeSchema,
  UuidSchema,
  authorize,
  authorizeExecution,
  modelGovernanceFailureText,
  type ExecutionContext,
  type EmployeeExecutionSnapshot,
  type Job,
  type JobStatus,
  type RequestContext,
  type RunEventType,
  type ReviewContinuationInput,
  type ChangesetActionInput,
} from '@allrice/contracts';
import type postgres from 'postgres';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import { wakeNativeQuestionWaits } from '../task-native-wait.ts';
import {
  isTerminalJobStatus,
  isTerminalRunEventType,
  leaseDeadline,
  queueMaintenanceAction,
  retryAvailableAt,
  type MaintenanceAction,
} from '../queue/policy.ts';
import {
  mapEvent,
  mapJob,
  mapRunSnapshot,
  type EventRow,
  type JobRow,
  type RunJobRow,
  type RunRow,
} from '../queue/row-mappers.ts';
import { resolveWorkspaceId } from '../workspace/service.ts';
import { ArtifactReviewError } from '../artifact-review.ts';
import { prepareReviewContinuation } from '../conversation/review-continuation.ts';
import { prepareChangesetAction } from '../changeset-service.ts';
import { cancelAssistantRootTransaction } from '../assistant-runtime.ts';
import { unboundedTaskDeadline } from '../task-runtime-policy.ts';
import {
  refreshTaskClock,
  refreshTaskClockForJob,
  recordTaskQuestion,
} from '../task-clock.ts';

export { queueMaintenanceAction } from '../queue/policy.ts';
export type { MaintenanceAction } from '../queue/policy.ts';

type TransactionSql = postgres.TransactionSql;
type JsonValue = Parameters<TransactionSql['json']>[0];

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  return serialized === undefined
    ? null
    : (JSON.parse(serialized) as JsonValue);
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
    reviewContinuation?: ReviewContinuationInput;
    changesetAction?: ChangesetActionInput;
    workflowBinding?: {
      employeeId: string;
      workflowRevisionId: string;
      sessionId: string | null;
    };
  } = {},
) {
  const submission = CreateRunInputSchema.parse(input);
  const taskPolicy =
    options.employeeBinding?.executionSnapshot.schemaVersion === 2
      ? options.employeeBinding.executionSnapshot.taskRuntimePolicy
      : undefined;
  if (submission.timeoutMs === 0 && taskPolicy?.timeoutMs !== 0)
    throw new QueueError('policy_denied');
  const ownerId = requireUser(context);
  const workspaceId = await resolveWorkspaceId(context, submission.workspaceId);
  await requireExecutionMembership(context, workspaceId);
  let availableAt = submission.availableAt
    ? new Date(submission.availableAt)
    : new Date();
  let timeoutAt =
    submission.timeoutMs === 0
      ? unboundedTaskDeadline
      : new Date(
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
    if (options.changesetAction && options.conversationDelivery) {
      const action = options.changesetAction;
      await prepareChangesetAction(
        transaction,
        { ...context, workspaceId },
        options.conversationDelivery.sessionId,
        action,
      );
      const duplicate =
        await transaction`select run_id from allrice_changeset_runs where organization_id=${context.organizationId} and workspace_id=${workspaceId} and actor_id=${ownerId} and artifact_id=${action.artifactId} and restore_of is not distinct from ${action.restoreOf}::uuid`;
      if (duplicate.length)
        throw new ArtifactReviewError('changeset_already_requested');
    }
    if (options.reviewContinuation && options.conversationDelivery) {
      await prepareReviewContinuation(
        transaction,
        { ...context, workspaceId },
        options.conversationDelivery.sessionId,
        options.reviewContinuation,
      );
      const feedbackId =
        options.reviewContinuation.kind === 'version_feedback'
          ? options.reviewContinuation.feedbackId
          : null;
      const prior =
        await transaction`select response_id from allrice_review_continuations
        where organization_id=${context.organizationId} and workspace_id=${workspaceId} and actor_id=${ownerId}
        and artifact_id=${options.reviewContinuation.artifactId} and kind=${options.reviewContinuation.kind}
        and feedback_id is not distinct from ${feedbackId}::uuid`;
      if (prior.length) throw new ArtifactReviewError('review_already_sent');
    }
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
      if (
        options.conversationDelivery.requestedMode === 'steer' &&
        (runtime?.state !== 'running' ||
          !runtime.active_run_id ||
          !runtime.active_turn_id ||
          runtime.active_turn_id !==
            options.conversationDelivery.expectedTurnId ||
          runtime.thread_generation !==
            options.conversationDelivery.expectedGeneration)
      )
        throw new ArtifactReviewError('input_turn_changed');
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
        timeoutAt =
          submission.timeoutMs === 0
            ? unboundedTaskDeadline
            : new Date(availableAt.getTime() + submission.timeoutMs);
      }
    }
    // Authorization expiry is independent of an unlimited execution budget.
    const policyExpiresAt = new Date(
      availableAt.getTime() +
        Math.max(submission.timeoutMs, 3_600_000) +
        24 * 60 * 60 * 1000,
    );

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
        ${submission.maxAttempts}, ${availableAt}, ${taskPolicy ? unboundedTaskDeadline : timeoutAt},
        ${transaction.json(toJsonValue(payload))}
      )
      returning id
    `;
    const job = jobs[0];
    if (!job) throw new Error('job creation failed');
    if (taskPolicy) {
      if (taskPolicy.timeoutMs !== submission.timeoutMs)
        throw new QueueError('conflict');
      await transaction`insert into allrice_task_clocks(run_id,organization_id,workspace_id,policy)
        values(${run.id},${context.organizationId},${workspaceId},${transaction.json(toJsonValue(taskPolicy))})`;
    }
    if (options.changesetAction && options.conversationDelivery) {
      const action = options.changesetAction;
      await transaction`insert into allrice_changeset_runs(run_id,organization_id,workspace_id,session_id,actor_id,artifact_id,checksum,restore_of)
        values(${run.id},${context.organizationId},${workspaceId},${options.conversationDelivery.sessionId},${ownerId},${action.artifactId},${action.checksum},${action.restoreOf})`;
    }
    if (options.reviewContinuation && options.conversationDelivery) {
      const review = options.reviewContinuation;
      await transaction`insert into allrice_review_continuations
        (response_id,organization_id,workspace_id,session_id,actor_id,artifact_id,checksum,kind,feedback_id,run_id)
        values (${options.conversationDelivery.clientUserMessageId},${context.organizationId},${workspaceId},
          ${options.conversationDelivery.sessionId},${ownerId},${review.artifactId},${review.checksum},${review.kind},
          ${review.kind === 'version_feedback' ? review.feedbackId : null},${run.id})`;
    }
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
          ${delivery === 'steer_pending' ? 'steer_only' : 'follow_up'},
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
            expected_generation, expected_turn_id, message, input_kind
          ) values (
            ${context.organizationId}, ${workspaceId},
            ${options.conversationDelivery.sessionId}, ${ownerId}, ${run.id},
            'steer', ${options.conversationDelivery.clientUserMessageId},
            ${expectedGeneration}, ${expectedTurnId},
            ${options.conversationDelivery.message},
            ${options.conversationDelivery.message.startsWith('allrice:user-question:v1:') ? 'ask_user' : 'steer_current'}
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
    // Persistent tree cutoff precedes job cancellation and native drain. No root
    // row means an unchanged legacy single-agent Run.
    await cancelAssistantRootTransaction(
      transaction,
      snapshot.id,
      randomUUID(),
    );
    const rows = await transaction<JobRow[]>`
      select * from allrice_jobs where run_id = ${snapshot.id} for update
    `;
    const job = rows[0];
    if (!job) throw new QueueError('not_found');
    if (job.status === 'canceled') return;
    if (isTerminalJobStatus(job.status)) throw new QueueError('conflict');
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
        and not exists (select 1 from allrice_conversation_followups f where f.run_id=candidate.run_id and f.mode='steer_only')
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
  await settleManagedBrowserTasksForJobAttempt(transaction, job, {
    status: input.jobStatus === 'canceled' ? 'canceled' : 'failed',
    errorCode:
      input.jobStatus === 'canceled'
        ? 'BROWSER_PARENT_RUN_CANCELED'
        : input.jobStatus === 'succeeded'
          ? 'BROWSER_PARENT_JOB_COMPLETED_WITH_ACTIVE_TASK'
          : input.code === 'JOB_TIMEOUT'
            ? 'BROWSER_PARENT_JOB_TIMEOUT'
            : 'BROWSER_PARENT_JOB_FAILED',
  });
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
  await refreshTaskClock(transaction, job.run_id);
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
      modelGovernanceFailureText(input.code) ??
      (input.code === 'SKILL_ARTIFACT_MISSING'
        ? 'Rice 暂时无法使用已引用的 Skill：Skill 文件在本地存储中缺失。请重新安装或刷新该 Skill 后重试。'
        : input.code === 'SKILL_ARTIFACT_MISMATCH' ||
            input.code === 'SKILL_ARTIFACT_INVALID'
          ? 'Rice 暂时无法使用已引用的 Skill：Skill 文件校验失败。请重新安装或刷新该 Skill 后重试。'
          : 'Rice 暂时无法完成这次请求，请稍后重试。');
    const text =
      input.runStatus === 'succeeded' && typeof result.answer === 'string'
        ? result.answer
        : input.runStatus === 'canceled'
          ? 'Rice 的这次执行已取消。'
          : failureText;
    const warning = ChatMessageContentSchema.shape.budgetWarning.safeParse(
      input.runStatus === 'succeeded' &&
        result.budgetWarning &&
        typeof result.budgetWarning === 'object'
        ? (result.budgetWarning as Record<string, unknown>).code
        : undefined,
    );
    await transaction`
      update allrice_messages
      set content = ${transaction.json(
        toJsonValue({
          text,
          citations,
          ...(warning.success && warning.data
            ? { budgetWarning: warning.data }
            : {}),
        }),
      )},
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

async function settleManagedBrowserTasksForJobAttempt(
  transaction: TransactionSql,
  job: Pick<JobRow, 'id' | 'organization_id' | 'workspace_id' | 'attempt'>,
  input: {
    status: 'failed' | 'canceled';
    errorCode: string;
  },
) {
  await transaction`
    update allrice_managed_browser_tasks
    set status = ${input.status},
        started_at = case
          when ${input.status} = 'failed' then coalesce(started_at, created_at)
          else started_at
        end,
        error_code = ${input.errorCode},
        completed_at = coalesce(completed_at, now())
    where organization_id = ${job.organization_id}
      and workspace_id = ${job.workspace_id}
      and job_id = ${job.id}
      and job_attempt = ${job.attempt}
      and status in ('queued', 'running')
  `;
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
    await refreshTaskClockForJob(transaction, jobId);
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
    // Only a persisted quiescent checkpoint can keep its original question
    // across owners. Transient native callbacks are still not recoverable.
    if (await refreshTaskClock(transaction, job.run_id)) {
      const [waits] =
        await transaction`select to_regclass(format('%I.allrice_native_question_waits',current_schema())) is not null as available`;
      if (waits?.available)
        await transaction`update allrice_task_questions q set pending=false where q.run_id=${job.run_id} and q.pending
        and not exists(select 1 from allrice_native_question_waits w where w.run_id=q.run_id and w.question_id=q.question_id and w.state='ready')`;
      else
        await transaction`update allrice_task_questions set pending=false where run_id=${job.run_id} and pending`;
    }
    const clock = await refreshTaskClock(transaction, job.run_id);
    if (clock) running.timeout_at = clock.deadlineAt;
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
  await refreshTaskClockForJob(transaction, jobId);
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
  if (isTerminalRunEventType(input.type)) throw new QueueError('conflict');
  const workerId = UuidSchema.parse(input.workerId);
  const jobId = UuidSchema.parse(input.jobId);
  const leaseToken = UuidSchema.parse(input.leaseToken);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const job = await lockedLeasedJob(transaction, workerId, jobId, leaseToken);
    if (input.type === 'harness.native')
      await recordTaskQuestion(transaction, job.run_id, input.payload);
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
      const availableAt = retryAvailableAt(
        job.attempt,
        input.retryBaseMs ?? 1_000,
      );
      await settleManagedBrowserTasksForJobAttempt(transaction, job, {
        status: 'failed',
        errorCode: 'BROWSER_JOB_ATTEMPT_RETRY',
      });
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
      await refreshTaskClock(transaction, job.run_id);
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

export async function maintainQueue(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('maintenance limit must be between 1 and 1000');
  }
  const now = new Date();
  const sql = getDatabase();
  await wakeNativeQuestionWaits(limit, sql);
  const rows = await sql<JobRow[]>`
      select * from allrice_jobs
      where status in ('queued', 'claimed', 'running', 'retry_wait')
        and (
          cancel_requested_at is not null
          or timeout_at <= ${now}
          or (status = 'retry_wait' and available_at <= ${now})
          or (status in ('claimed', 'running') and lease_expires_at <= ${now})
        )
      order by updated_at, id
      limit ${limit}
    `;
  const counts: Record<Exclude<MaintenanceAction, 'none'>, number> = {
    promote_retry: 0,
    cancel: 0,
    timeout: 0,
    recover_lease: 0,
    dead_letter: 0,
  };
  for (const candidate of rows) {
    // Same root -> clock -> job order as dispatch; one root per transaction.
    await sql.begin(async (transaction) => {
      await refreshTaskClockForJob(transaction, candidate.id);
      const [job] = await transaction<
        JobRow[]
      >`select * from allrice_jobs where id=${candidate.id} for update`;
      if (
        !job ||
        !['queued', 'claimed', 'running', 'retry_wait'].includes(job.status)
      )
        return;
      const action = queueMaintenanceAction(job, new Date());
      if (action === 'none') return;
      counts[action] += 1;
      if (action === 'promote_retry') {
        await transaction`
          update allrice_jobs set status = 'queued', updated_at = ${now}
          where id = ${job.id}
        `;
        return;
      }
      if (action === 'cancel') {
        await transitionTerminal(transaction, job, {
          jobStatus: 'canceled',
          runStatus: 'canceled',
          eventType: 'run.canceled',
          payload: { reason: job.cancel_reason ?? 'user_requested' },
        });
        return;
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
        return;
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
        return;
      }
      await settleManagedBrowserTasksForJobAttempt(transaction, job, {
        status: 'failed',
        errorCode: 'BROWSER_WORKER_LEASE_LOST',
      });
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
      await refreshTaskClock(transaction, job.run_id);
    });
  }
  return counts;
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
