import { createHash, randomUUID } from 'node:crypto';

import {
  DecideWorkflowApprovalInputSchema,
  StartWorkflowRunInputSchema,
  UuidSchema,
  WorkflowDefinitionSchema,
  WorkflowRunSchema,
  WorkflowStepRunSchema,
  type ExecutionContext,
  type RequestContext,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowStepRun,
  WorkflowEvaluationSchema,
} from '@allrice/contracts';
import type postgres from 'postgres';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import { lockWorkspaceStorageQuota } from '../core/storage-quota.ts';
import { enqueueRun } from './queue.ts';
import { resolveWorkspaceId } from '../workspace/service.ts';

type TransactionSql = postgres.TransactionSql;
type JsonValue = Parameters<TransactionSql['json']>[0];

function toJson(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  return encoded === undefined ? null : (JSON.parse(encoded) as JsonValue);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function workflowDigest(value: unknown) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

interface WorkflowRunRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  run_id: string;
  employee_id: string;
  workflow_revision_id: string;
  session_id: string | null;
  status: WorkflowRun['status'];
  definition_snapshot: unknown;
  input: unknown;
  output: unknown | null;
  current_step_key: string | null;
  checkpoint: Record<string, unknown>;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface WorkflowStepRow {
  id: string;
  workflow_run_id: string;
  step_key: string;
  name: string;
  step_kind: WorkflowStepRun['kind'];
  status: WorkflowStepRun['status'];
  attempt: number;
  max_attempts: number;
  input: unknown;
  input_digest: string | null;
  output: unknown | null;
  output_digest: string | null;
  idempotency_key: string;
  side_effect_committed: boolean;
  approval_id: string | null;
  checkpoint: Record<string, unknown>;
  lease_token: string | null;
  lease_expires_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  started_at: Date | null;
  completed_at: Date | null;
}

export class WorkflowRuntimeError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'conflict'
      | 'lease_lost'
      | 'approval_required'
      | 'needs_attention',
  ) {
    super(code);
  }
}

function actorId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function canUseWorkspace(context: RequestContext, workspaceId: string) {
  const actor = actorId(context);
  return context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actor &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
}

function mapStep(row: WorkflowStepRow) {
  return WorkflowStepRunSchema.parse({
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepKey: row.step_key,
    name: row.name,
    kind: row.step_kind,
    status: row.status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    inputDigest: row.input_digest,
    outputDigest: row.output_digest,
    output: row.output,
    idempotencyKey: row.idempotency_key,
    approvalId: row.approval_id,
    sideEffectCommitted: row.side_effect_committed,
    checkpoint: row.checkpoint,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

function mapRun(row: WorkflowRunRow, steps: WorkflowStepRow[]) {
  return WorkflowRunSchema.parse({
    id: row.id,
    runId: row.run_id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    employeeId: row.employee_id,
    workflowRevisionId: row.workflow_revision_id,
    sessionId: row.session_id,
    status: row.status,
    definition: row.definition_snapshot,
    input: row.input,
    output: row.output,
    currentStepKey: row.current_step_key,
    checkpoint: row.checkpoint,
    steps: steps.map(mapStep),
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

async function appendWorkflowEvent(
  transaction: TransactionSql,
  run: Pick<WorkflowRunRow, 'organization_id' | 'workspace_id' | 'run_id'>,
  type: string,
  payload: unknown,
) {
  await transaction`select id from allrice_runs where id = ${run.run_id} for update`;
  const sequences = await transaction<{ sequence: number }[]>`
    select coalesce(max(sequence), -1)::integer + 1 as sequence
    from allrice_run_events where run_id = ${run.run_id}
  `;
  await transaction`
    insert into allrice_run_events (
      organization_id, workspace_id, run_id, sequence, event_type, payload
    ) values (
      ${run.organization_id}, ${run.workspace_id}, ${run.run_id},
      ${sequences[0]?.sequence ?? 0}, ${type}, ${transaction.json(toJson(payload))}
    )
  `;
}

async function insertWorkflowRuntime(
  transaction: TransactionSql,
  input: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
    runId: string;
    employeeId: string;
    workflowRevisionId: string;
    sessionId: string | null;
    definition: WorkflowDefinition;
    value: unknown;
  },
) {
  const rows = await transaction<WorkflowRunRow[]>`
    insert into allrice_workflow_runs (
      organization_id, workspace_id, owner_id, run_id, employee_id,
      workflow_revision_id, session_id, definition_snapshot, input
    ) values (
      ${input.organizationId}, ${input.workspaceId}, ${input.ownerId},
      ${input.runId}, ${input.employeeId}, ${input.workflowRevisionId},
      ${input.sessionId}, ${transaction.json(toJson(input.definition))},
      ${transaction.json(toJson(input.value))}
    )
    on conflict (run_id) do update set run_id = excluded.run_id
    returning *
  `;
  const workflowRun = rows[0];
  if (!workflowRun) throw new Error('workflow run creation failed');
  for (const step of input.definition.steps) {
    await transaction`
      insert into allrice_workflow_step_runs (
        organization_id, workspace_id, workflow_run_id, step_key, name,
        step_kind, max_attempts, input, idempotency_key
      ) values (
        ${input.organizationId}, ${input.workspaceId}, ${workflowRun.id},
        ${step.key}, ${step.name}, ${step.kind}, ${step.maxAttempts},
        ${transaction.json(toJson(step.input))},
        ${`${workflowRun.id}:${step.key}`}
      ) on conflict (workflow_run_id, step_key) do nothing
    `;
  }
  return workflowRun;
}

export async function startWorkflowRun(
  context: RequestContext,
  input: unknown,
) {
  const request = StartWorkflowRunInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, request.workspaceId);
  if (!canUseWorkspace(context, workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  const ownerId = actorId(context);
  const sql = getDatabase();
  const revisions = await sql<
    {
      definition: unknown;
      employee_allowed: boolean;
      session_allowed: boolean;
    }[]
  >`
    select r.definition,
      (
        exists (
          select 1 from allrice_employee_assignments a
          where a.organization_id = r.organization_id
            and a.workspace_id = r.workspace_id
            and a.employee_id = ${request.employeeId}
            and a.user_id = ${ownerId} and a.active
        ) or exists (
          select 1 from allrice_memberships m
          where m.organization_id = r.organization_id
            and (m.workspace_id is null or m.workspace_id = r.workspace_id)
            and m.user_id = ${ownerId} and m.active and m.role = 'admin'
        )
      ) as employee_allowed,
      (${request.sessionId}::uuid is null or exists (
        select 1 from allrice_chat_sessions s
        where s.id = ${request.sessionId} and s.organization_id = r.organization_id
          and s.workspace_id = r.workspace_id and s.owner_id = ${ownerId}
          and s.archived_at is null
      )) as session_allowed
    from allrice_workflow_revisions r
    join allrice_workflows w on w.id = r.workflow_id
    join allrice_employee_workflow_bindings b
      on b.workflow_revision_id = r.id and b.employee_id = ${request.employeeId}
    join allrice_employees e on e.id = b.employee_id
    where r.id = ${request.workflowRevisionId}
      and r.organization_id = ${context.organizationId}
      and r.workspace_id = ${workspaceId}
      and r.status = 'published' and w.status = 'active'
      and b.enabled and e.status = 'active'
  `;
  const revision = revisions[0];
  if (!revision || !revision.employee_allowed || !revision.session_allowed) {
    throw new WorkflowRuntimeError('not_found');
  }
  const definition = WorkflowDefinitionSchema.parse(revision.definition);
  const queued = await enqueueRun(
    context,
    {
      workspaceId,
      idempotencyKey: `workflow:${request.idempotencyKey}`,
      type: 'allrice.workflow.run',
      input: {
        employeeId: request.employeeId,
        workflowRevisionId: request.workflowRevisionId,
      },
      maxAttempts: 10,
      timeoutMs: 86_400_000,
      availableAt: new Date(Date.now() + 1_000).toISOString(),
    },
    {
      workflowBinding: {
        employeeId: request.employeeId,
        workflowRevisionId: request.workflowRevisionId,
        sessionId: request.sessionId,
      },
    },
  );
  await sql.begin((transaction) =>
    insertWorkflowRuntime(transaction, {
      organizationId: context.organizationId,
      workspaceId,
      ownerId,
      runId: queued.run.id,
      employeeId: request.employeeId,
      workflowRevisionId: request.workflowRevisionId,
      sessionId: request.sessionId,
      definition,
      value: request.input,
    }),
  );
  return getWorkflowRun(context, workspaceId, queued.run.id);
}

export async function ensureWorkflowRunForExecution(input: {
  context: ExecutionContext;
  ownerId: string;
  employeeId: string;
  workflowRevisionId: string;
  sessionId: string | null;
  value: unknown;
}) {
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const existing = await transaction<{ id: string }[]>`
      select id from allrice_workflow_runs where run_id = ${input.context.runId}
    `;
    if (existing[0]) return;
    const revisions = await transaction<{ definition: unknown }[]>`
      select r.definition from allrice_workflow_revisions r
      join allrice_employee_workflow_bindings b
        on b.workflow_revision_id = r.id and b.employee_id = ${input.employeeId}
      where r.id = ${input.workflowRevisionId}
        and r.organization_id = ${input.context.organizationId}
        and r.workspace_id = ${input.context.workspaceId}
        and r.status = 'published' and b.enabled
    `;
    const revision = revisions[0];
    if (!revision) throw new WorkflowRuntimeError('not_found');
    await insertWorkflowRuntime(transaction, {
      organizationId: input.context.organizationId,
      workspaceId: input.context.workspaceId!,
      ownerId: input.ownerId,
      runId: input.context.runId,
      employeeId: input.employeeId,
      workflowRevisionId: input.workflowRevisionId,
      sessionId: input.sessionId,
      definition: WorkflowDefinitionSchema.parse(revision.definition),
      value: input.value,
    });
  });
}

async function readRunByBaseRun(input: {
  organizationId: string;
  workspaceId: string;
  runId: string;
}) {
  const sql = getDatabase();
  const runs = await sql<WorkflowRunRow[]>`
    select * from allrice_workflow_runs
    where organization_id = ${input.organizationId}
      and workspace_id = ${input.workspaceId}
      and run_id = ${UuidSchema.parse(input.runId)}
  `;
  const run = runs[0];
  if (!run) throw new WorkflowRuntimeError('not_found');
  const steps = await sql<WorkflowStepRow[]>`
    select * from allrice_workflow_step_runs
    where workflow_run_id = ${run.id} order by id
  `;
  return { row: run, snapshot: mapRun(run, steps), stepRows: steps };
}

export async function getWorkflowRun(
  context: RequestContext,
  workspaceIdInput: string,
  runId: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const result = await readRunByBaseRun({
    organizationId: context.organizationId,
    workspaceId,
    runId,
  });
  const user = actorId(context);
  const admin = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === user &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId) &&
      membership.role === 'admin',
  );
  if (result.row.owner_id !== user && !admin) {
    throw new WorkflowRuntimeError('not_found');
  }
  return result.snapshot;
}

export async function listWorkflowRuns(
  context: RequestContext,
  input: {
    workspaceId: string;
    employeeId?: string;
    sessionId?: string;
    limit?: number;
  },
) {
  const workspaceId = await resolveWorkspaceId(context, input.workspaceId);
  const user = actorId(context);
  const admin = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === user &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId) &&
      membership.role === 'admin',
  );
  const employeeId = input.employeeId
    ? UuidSchema.parse(input.employeeId)
    : null;
  const sessionId = input.sessionId ? UuidSchema.parse(input.sessionId) : null;
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const sql = getDatabase();
  const rows = await sql<WorkflowRunRow[]>`
    select * from allrice_workflow_runs
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and (${admin} or owner_id = ${user})
      and (${employeeId}::uuid is null or employee_id = ${employeeId})
      and (${sessionId}::uuid is null or session_id = ${sessionId})
    order by created_at desc limit ${limit}
  `;
  const stepRows = rows.length
    ? await sql<WorkflowStepRow[]>`
        select * from allrice_workflow_step_runs
        where workflow_run_id in ${sql(rows.map((row) => row.id))}
        order by id
      `
    : [];
  return rows.map((row) =>
    mapRun(
      row,
      stepRows.filter((step) => step.workflow_run_id === row.id),
    ),
  );
}

export async function getWorkflowExecution(input: {
  organizationId: string;
  workspaceId: string;
  runId: string;
}) {
  return (await readRunByBaseRun(input)).snapshot;
}

export async function startWorkflowStep(input: {
  context: ExecutionContext;
  workerId: string;
  jobId: string;
  leaseToken: string;
  stepKey: string;
  value: unknown;
  leaseMs: number;
}) {
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const jobs = await transaction<
      {
        id: string;
        run_id: string;
        status: string;
        worker_id: string | null;
        lease_token: string | null;
      }[]
    >`select id, run_id, status, worker_id, lease_token from allrice_jobs where id = ${input.jobId} for update`;
    const job = jobs[0];
    if (
      !job ||
      job.status !== 'running' ||
      job.worker_id !== input.workerId ||
      job.lease_token !== input.leaseToken
    ) {
      throw new WorkflowRuntimeError('lease_lost');
    }
    const runs = await transaction<WorkflowRunRow[]>`
      select * from allrice_workflow_runs where run_id = ${job.run_id} for update
    `;
    const run = runs[0];
    if (!run) throw new WorkflowRuntimeError('not_found');
    const steps = await transaction<WorkflowStepRow[]>`
      select * from allrice_workflow_step_runs
      where workflow_run_id = ${run.id} and step_key = ${input.stepKey} for update
    `;
    const step = steps[0];
    if (!step) throw new WorkflowRuntimeError('not_found');
    if (step.status === 'succeeded')
      return { step: mapStep(step), replay: true };
    if (
      step.status === 'running' &&
      step.side_effect_committed &&
      step.output_digest
    ) {
      const recovered = await transaction<WorkflowStepRow[]>`
        update allrice_workflow_step_runs set status = 'succeeded',
          lease_token = null, lease_expires_at = null, completed_at = coalesce(completed_at, now()),
          updated_at = now() where id = ${step.id} returning *
      `;
      return { step: mapStep(recovered[0]!), replay: true };
    }
    if (step.attempt >= step.max_attempts) {
      await transaction`
        update allrice_workflow_step_runs set status = 'needs_attention',
          error_code = 'STEP_ATTEMPTS_EXHAUSTED', updated_at = now() where id = ${step.id}
      `;
      await transaction`
        update allrice_workflow_runs set status = 'needs_attention',
          current_step_key = ${step.step_key} where id = ${run.id}
      `;
      throw new WorkflowRuntimeError('needs_attention');
    }
    const digest = workflowDigest(input.value);
    const leaseExpires = new Date(Date.now() + input.leaseMs);
    const updated = await transaction<WorkflowStepRow[]>`
      update allrice_workflow_step_runs set status = 'running',
        attempt = attempt + 1, input = ${transaction.json(toJson(input.value))},
        input_digest = ${digest}, lease_token = ${input.leaseToken},
        lease_expires_at = ${leaseExpires}, started_at = coalesce(started_at, now()),
        error_code = null, error_message = null, updated_at = now()
      where id = ${step.id} returning *
    `;
    await transaction`
      update allrice_workflow_runs set status = 'running',
        current_step_key = ${step.step_key}, started_at = coalesce(started_at, now())
      where id = ${run.id}
    `;
    await appendWorkflowEvent(transaction, run, 'step.started', {
      workflowRunId: run.id,
      stepKey: step.step_key,
      name: step.name,
      kind: step.step_kind,
      attempt: step.attempt + 1,
    });
    return { step: mapStep(updated[0]!), replay: false };
  });
}

export async function completeWorkflowStep(input: {
  context: ExecutionContext;
  stepId: string;
  leaseToken: string;
  output: unknown;
  sideEffectCommitted?: boolean;
  checkpoint?: Record<string, unknown>;
}) {
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const steps = await transaction<WorkflowStepRow[]>`
      select * from allrice_workflow_step_runs where id = ${input.stepId} for update
    `;
    const step = steps[0];
    if (
      !step ||
      step.status !== 'running' ||
      step.lease_token !== input.leaseToken
    ) {
      throw new WorkflowRuntimeError('lease_lost');
    }
    const runs = await transaction<WorkflowRunRow[]>`
      select * from allrice_workflow_runs where id = ${step.workflow_run_id} for update
    `;
    const run = runs[0];
    if (
      !run ||
      run.organization_id !== input.context.organizationId ||
      run.workspace_id !== input.context.workspaceId
    ) {
      throw new WorkflowRuntimeError('not_found');
    }
    const digest = workflowDigest(input.output);
    const updated = await transaction<WorkflowStepRow[]>`
      update allrice_workflow_step_runs set status = 'succeeded',
        output = ${transaction.json(toJson(input.output))}, output_digest = ${digest},
        side_effect_committed = ${input.sideEffectCommitted ?? false},
        checkpoint = ${transaction.json(toJson(input.checkpoint ?? {}))},
        lease_token = null, lease_expires_at = null, completed_at = now(), updated_at = now()
      where id = ${step.id} returning *
    `;
    await appendWorkflowEvent(transaction, run, 'step.completed', {
      workflowRunId: run.id,
      stepKey: step.step_key,
      name: step.name,
      kind: step.step_kind,
      attempt: step.attempt,
      outputDigest: digest,
    });
    return mapStep(updated[0]!);
  });
}

export async function pauseWorkflowForApproval(input: {
  context: ExecutionContext;
  workerId: string;
  jobId: string;
  leaseToken: string;
  stepKey: string;
  value: unknown;
}) {
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const jobs = await transaction<
      {
        id: string;
        run_id: string;
        status: string;
        worker_id: string | null;
        lease_token: string | null;
        owner_id: string;
      }[]
    >`select id, run_id, status, worker_id, lease_token, owner_id from allrice_jobs where id = ${input.jobId} for update`;
    const job = jobs[0];
    if (
      !job ||
      job.status !== 'running' ||
      job.worker_id !== input.workerId ||
      job.lease_token !== input.leaseToken
    ) {
      throw new WorkflowRuntimeError('lease_lost');
    }
    const runs = await transaction<WorkflowRunRow[]>`
      select * from allrice_workflow_runs where run_id = ${job.run_id} for update
    `;
    const run = runs[0];
    if (!run) throw new WorkflowRuntimeError('not_found');
    const steps = await transaction<WorkflowStepRow[]>`
      select * from allrice_workflow_step_runs
      where workflow_run_id = ${run.id} and step_key = ${input.stepKey} for update
    `;
    const step = steps[0];
    if (!step) throw new WorkflowRuntimeError('not_found');
    if (step.status === 'waiting_approval' && step.approval_id) {
      return { approvalId: step.approval_id, workflowRunId: run.id };
    }
    const approvalId = randomUUID();
    const digest = workflowDigest(input.value);
    await transaction`
      insert into allrice_approval_requests (
        id, organization_id, workspace_id, run_id, actor_id, resource_type,
        resource_id, action, input_digest
      ) values (
        ${approvalId}, ${run.organization_id}, ${run.workspace_id}, ${run.run_id},
        ${job.owner_id}, 'workflow_step', ${step.id}, 'workflow.step.approve', ${digest}
      )
    `;
    await transaction`
      update allrice_workflow_step_runs set status = 'waiting_approval',
        approval_id = ${approvalId}, input = ${transaction.json(toJson(input.value))},
        input_digest = ${digest}, lease_token = null, lease_expires_at = null,
        updated_at = now() where id = ${step.id}
    `;
    await transaction`
      update allrice_workflow_runs set status = 'waiting_approval',
        current_step_key = ${step.step_key} where id = ${run.id}
    `;
    await transaction`
      update allrice_jobs set status = 'waiting_approval', worker_id = null,
        lease_token = null, claimed_at = null, heartbeat_at = null,
        lease_expires_at = null, updated_at = now() where id = ${job.id}
    `;
    await transaction`
      update allrice_runs set state = 'waiting_approval', updated_at = now()
      where id = ${run.run_id}
    `;
    await appendWorkflowEvent(transaction, run, 'step.waiting_approval', {
      workflowRunId: run.id,
      stepKey: step.step_key,
      name: step.name,
      approvalId,
    });
    await appendWorkflowEvent(transaction, run, 'approval.requested', {
      workflowRunId: run.id,
      stepKey: step.step_key,
      approvalId,
      summary: step.name,
    });
    return { approvalId, workflowRunId: run.id };
  });
}

export async function decideWorkflowApproval(
  context: RequestContext,
  approvalIdInput: string,
  input: unknown,
) {
  const decision = DecideWorkflowApprovalInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, decision.workspaceId);
  const user = actorId(context);
  const approvalId = UuidSchema.parse(approvalIdInput);
  const sql = getDatabase();
  const baseRunId = await sql.begin(async (transaction) => {
    const approvals = await transaction<
      {
        id: string;
        status: string;
        actor_id: string;
        resource_id: string;
        organization_id: string;
        workspace_id: string;
        run_id: string;
      }[]
    >`
      select * from allrice_approval_requests
      where id = ${approvalId} and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId} and resource_type = 'workflow_step'
      for update
    `;
    const approval = approvals[0];
    if (!approval || approval.actor_id !== user)
      throw new WorkflowRuntimeError('not_found');
    if (approval.status !== 'pending') return approval.run_id;
    const steps = await transaction<WorkflowStepRow[]>`
      select * from allrice_workflow_step_runs where id = ${approval.resource_id} for update
    `;
    const step = steps[0];
    if (!step || step.approval_id !== approval.id)
      throw new WorkflowRuntimeError('conflict');
    const runs = await transaction<WorkflowRunRow[]>`
      select * from allrice_workflow_runs where id = ${step.workflow_run_id} for update
    `;
    const run = runs[0];
    if (!run) throw new WorkflowRuntimeError('not_found');
    await transaction`
      update allrice_approval_requests set status = ${decision.decision},
        decided_by = ${user}, decided_at = now(), decision_reason = ${decision.reason}
      where id = ${approval.id}
    `;
    await appendWorkflowEvent(transaction, run, 'approval.decided', {
      workflowRunId: run.id,
      stepKey: step.step_key,
      approvalId,
      decision: decision.decision,
      reason: decision.reason,
    });
    if (decision.decision === 'approved') {
      const approvalOutput = { approved: true, reason: decision.reason };
      const approvalStep = step.step_kind === 'approval';
      await transaction`
        update allrice_workflow_step_runs set
          status = ${approvalStep ? 'succeeded' : 'pending'},
          output = ${
            approvalStep ? transaction.json(toJson(approvalOutput)) : null
          },
          output_digest = ${approvalStep ? workflowDigest(approvalOutput) : null},
          checkpoint = ${transaction.json(toJson({ approval: approvalOutput }))},
          approval_id = null,
          completed_at = ${approvalStep ? new Date() : null}, updated_at = now()
        where id = ${step.id}
      `;
      await transaction`
        update allrice_workflow_runs set status = 'queued', current_step_key = null
        where id = ${run.id}
      `;
      await transaction`
        update allrice_jobs set status = 'queued', available_at = now(), updated_at = now()
        where run_id = ${run.run_id} and status = 'waiting_approval'
      `;
      await transaction`
        update allrice_runs set state = 'queued', updated_at = now() where id = ${run.run_id}
      `;
      if (approvalStep) {
        await appendWorkflowEvent(transaction, run, 'step.completed', {
          workflowRunId: run.id,
          stepKey: step.step_key,
          name: step.name,
          kind: step.step_kind,
          outcome: 'approved',
        });
      }
    } else {
      await transaction`
        update allrice_workflow_step_runs set status = 'failed',
          error_code = 'APPROVAL_REJECTED', error_message = ${decision.reason},
          completed_at = now(), updated_at = now() where id = ${step.id}
      `;
      await transaction`
        update allrice_workflow_runs set status = 'failed', completed_at = now()
        where id = ${run.id}
      `;
      await transaction`
        update allrice_jobs set status = 'failed', completed_at = now(), updated_at = now(),
          last_error_code = 'APPROVAL_REJECTED', last_error_message = ${decision.reason}
        where run_id = ${run.run_id} and status = 'waiting_approval'
      `;
      await transaction`
        update allrice_runs set state = 'failed', error_code = 'APPROVAL_REJECTED',
          error_message = ${decision.reason}, completed_at = now(), updated_at = now()
        where id = ${run.run_id}
      `;
      const employeeRuns = await transaction<
        { assistant_message_id: string }[]
      >`
        update allrice_employee_runs set status = 'failed',
          error_code = 'APPROVAL_REJECTED', error_message = ${decision.reason},
          completed_at = now() where run_id = ${run.run_id}
        returning assistant_message_id
      `;
      if (employeeRuns[0]) {
        await transaction`
          update allrice_messages set
            content = ${transaction.json(
              toJson({
                text: '你已拒绝这一步操作，Rice 已停止该工作流。',
                citations: [],
              }),
            )},
            status = 'failed', error_code = 'APPROVAL_REJECTED', completed_at = now()
          where id = ${employeeRuns[0].assistant_message_id}
        `;
      }
      await appendWorkflowEvent(transaction, run, 'run.failed', {
        code: 'APPROVAL_REJECTED',
        stepKey: step.step_key,
      });
    }
    return run.run_id;
  });
  return getWorkflowRun(context, workspaceId, baseRunId);
}

export async function completeWorkflowRun(input: {
  context: ExecutionContext;
  output: unknown;
}) {
  const sql = getDatabase();
  await sql`
    update allrice_workflow_runs set status = 'succeeded',
      output = ${sql.json(toJson(input.output))}, current_step_key = null,
      completed_at = now()
    where organization_id = ${input.context.organizationId}
      and workspace_id = ${input.context.workspaceId}
      and run_id = ${input.context.runId}
  `;
}

export async function registerWorkflowArtifact(input: {
  context: ExecutionContext;
  ownerId: string;
  stepKey: string;
  object: {
    id: string;
    key: string;
    checksum: string;
    mediaType: string;
    sizeBytes: number;
  };
  name: string;
}) {
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await lockWorkspaceStorageQuota(
      transaction,
      input.context.organizationId,
      input.context.workspaceId,
    );
    const runs = await transaction<WorkflowRunRow[]>`
      select * from allrice_workflow_runs
      where organization_id = ${input.context.organizationId}
        and workspace_id = ${input.context.workspaceId}
        and run_id = ${input.context.runId} for update
    `;
    const run = runs[0];
    if (!run || run.owner_id !== input.ownerId) {
      throw new WorkflowRuntimeError('not_found');
    }
    const existing = await transaction<
      { id: string; storage_object_id: string; created_at: Date }[]
    >`
      select id, storage_object_id, created_at from allrice_workflow_artifacts
      where workflow_run_id = ${run.id}
        and step_key = ${input.stepKey}
        and storage_object_id = ${input.object.id}
    `;
    if (existing[0]) {
      return {
        id: existing[0].id,
        storageObjectId: existing[0].storage_object_id,
        createdAt: existing[0].created_at.toISOString(),
      };
    }
    const [stored] = await transaction<
      {
        organization_id: string;
        workspace_id: string;
        owner_id: string;
        object_key: string;
        checksum: string;
        media_type: string;
        size_bytes: number | string;
        state: string;
      }[]
    >`select organization_id,workspace_id,owner_id,object_key,checksum,media_type,size_bytes,state
      from allrice_storage_objects where id=${UuidSchema.parse(input.object.id)}`;
    if (
      stored &&
      (stored.organization_id !== run.organization_id ||
        stored.workspace_id !== run.workspace_id ||
        stored.owner_id !== run.owner_id ||
        stored.object_key !== input.object.key ||
        stored.checksum !== input.object.checksum ||
        stored.media_type !== input.object.mediaType ||
        Number(stored.size_bytes) !== input.object.sizeBytes ||
        stored.state !== 'ready')
    )
      throw new WorkflowRuntimeError('conflict');
    const [quota] = await transaction<
      { limit_bytes: number | string; used_bytes: number | string }[]
    >`
      select coalesce(q.limit_bytes,1073741824) as limit_bytes,
        coalesce((select sum(size_bytes) from allrice_storage_objects where organization_id=${run.organization_id}
          and workspace_id=${run.workspace_id} and state<>'deleted'),0) as used_bytes
      from allrice_workspaces w left join allrice_storage_quotas q on q.organization_id=w.organization_id and q.workspace_id=w.id
      where w.id=${run.workspace_id} and w.organization_id=${run.organization_id}`;
    if (
      !Number.isSafeInteger(input.object.sizeBytes) ||
      input.object.sizeBytes < 0 ||
      !quota ||
      Number(quota.used_bytes) + (stored ? 0 : input.object.sizeBytes) >
        Number(quota.limit_bytes)
    )
      throw new DataAccessError('quota_exceeded');
    await transaction`
      insert into allrice_storage_objects (
        id, organization_id, workspace_id, owner_id, object_key, category,
        media_type, size_bytes, checksum, visibility, state, immutable
      ) values (
        ${UuidSchema.parse(input.object.id)}, ${run.organization_id},
        ${run.workspace_id}, ${run.owner_id}, ${input.object.key}, 'artifacts',
        ${input.object.mediaType}, ${input.object.sizeBytes},
        ${input.object.checksum}, 'private', 'ready', true
      ) on conflict (id) do nothing
    `;
    const artifacts = await transaction<
      { id: string; storage_object_id: string; created_at: Date }[]
    >`
      insert into allrice_workflow_artifacts (
        organization_id, workspace_id, workflow_run_id, step_key,
        storage_object_id, name, media_type, checksum, size_bytes
      ) values (
        ${run.organization_id}, ${run.workspace_id}, ${run.id}, ${input.stepKey},
        ${input.object.id}, ${input.name}, ${input.object.mediaType},
        ${input.object.checksum}, ${input.object.sizeBytes}
      )
      on conflict (workflow_run_id, step_key, storage_object_id) do update
        set name = excluded.name
      returning id, storage_object_id, created_at
    `;
    const artifact = artifacts[0];
    if (!artifact) throw new Error('workflow artifact creation failed');
    await appendWorkflowEvent(transaction, run, 'artifact.created', {
      workflowRunId: run.id,
      artifactId: artifact.id,
      storageObjectId: artifact.storage_object_id,
      stepKey: input.stepKey,
      name: input.name,
      checksum: input.object.checksum,
    });
    return {
      id: artifact.id,
      storageObjectId: artifact.storage_object_id,
      createdAt: artifact.created_at.toISOString(),
    };
  });
}

export async function recordWorkflowEvaluation(input: {
  context: ExecutionContext;
  metrics: unknown;
}) {
  const metrics = WorkflowEvaluationSchema.parse(input.metrics);
  const sql = getDatabase();
  await sql`
    insert into allrice_workflow_evaluations (
      organization_id, workspace_id, workflow_run_id, metrics
    )
    select organization_id, workspace_id, id, ${sql.json(toJson(metrics))}
    from allrice_workflow_runs
    where organization_id = ${input.context.organizationId}
      and workspace_id = ${input.context.workspaceId}
      and run_id = ${input.context.runId}
    on conflict (workflow_run_id) do update
      set metrics = excluded.metrics, created_at = now()
  `;
  return metrics;
}

export async function failWorkflowStep(input: {
  context: ExecutionContext;
  stepId: string;
  leaseToken: string;
  code: string;
  message: string;
}) {
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const steps = await transaction<WorkflowStepRow[]>`
      select * from allrice_workflow_step_runs where id = ${input.stepId} for update
    `;
    const step = steps[0];
    if (
      !step ||
      step.status !== 'running' ||
      step.lease_token !== input.leaseToken
    ) {
      throw new WorkflowRuntimeError('lease_lost');
    }
    const runs = await transaction<WorkflowRunRow[]>`
      select * from allrice_workflow_runs where id = ${step.workflow_run_id} for update
    `;
    const run = runs[0];
    if (
      !run ||
      run.organization_id !== input.context.organizationId ||
      run.workspace_id !== input.context.workspaceId
    ) {
      throw new WorkflowRuntimeError('not_found');
    }
    const retrying = step.attempt < step.max_attempts;
    await transaction`
      update allrice_workflow_step_runs set
        status = ${retrying ? 'pending' : 'needs_attention'},
        lease_token = null, lease_expires_at = null,
        error_code = ${input.code}, error_message = ${input.message}, updated_at = now()
      where id = ${step.id}
    `;
    await transaction`
      update allrice_workflow_runs set
        status = ${retrying ? 'queued' : 'needs_attention'},
        current_step_key = ${step.step_key}
      where id = ${run.id}
    `;
    await appendWorkflowEvent(
      transaction,
      run,
      retrying ? 'step.retrying' : 'run.needs_attention',
      {
        workflowRunId: run.id,
        stepKey: step.step_key,
        attempt: step.attempt,
        code: input.code,
      },
    );
    return { retrying, attempt: step.attempt, maxAttempts: step.max_attempts };
  });
}
