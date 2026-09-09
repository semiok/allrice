import { createHash, randomUUID } from 'node:crypto';

import {
  ExecutionTargetSchema,
  ExternalActionRiskSchema,
  ManagedBrowserEvidenceArtifactSchema,
  ManagedBrowserEvidenceSchema,
  ManagedBrowserStepSchema,
  ManagedBrowserTaskSchema,
  ExternalActionSchema,
  ObjectKeySchema,
  RegisterExecutionTargetInputSchema,
  StorageObjectSchema,
  UuidSchema,
  makeObjectKey,
  type ExecutionContext,
  type ExecutionTarget,
  type ManagedBrowserEvidence,
  type ManagedBrowserEvidenceArtifact,
  type ManagedBrowserTask,
  type RunStatus,
  type RequestContext,
} from '@allrice/contracts';
import type postgres from 'postgres';
import { z } from 'zod';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import { lockWorkspaceStorageQuota } from '../core/storage-quota.ts';
import { resolveWorkspaceId } from '../workspace/service.ts';

type TargetRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  kind: ExecutionTarget['kind'];
  label: string;
  state: ExecutionTarget['state'];
  capabilities: unknown;
  concurrency_limit: number;
  timeout_seconds: number;
  last_heartbeat_at: Date | null;
  unavailable_reason: string | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
};

type JsonValue = Parameters<postgres.Sql['json']>[0];
const defaultWorkspaceQuotaBytes = 1024 * 1024 * 1024;

type BrowserTaskRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  run_id: string;
  job_id: string;
  job_attempt: number;
  tool_call_id: string;
  target_id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  start_url: string;
  allowed_domains: unknown;
  steps: unknown;
  evidence: unknown;
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  cancel_requested_at: Date | null;
  completed_at: Date | null;
  evidence_artifacts?: unknown;
};

type BrowserEvidenceArtifactRow = {
  id: string;
  task_id: string;
  object_id: string;
  kind: ManagedBrowserEvidenceArtifact['kind'];
  name: string;
  checksum: string;
  media_type: string;
  size_bytes: number | string;
  created_at: Date;
};

const ManagedBrowserExecutionLeaseSchema = z
  .object({
    attempt: z.number().int().min(1),
    leaseToken: UuidSchema,
  })
  .strict();

export type ManagedBrowserExecutionLease = z.infer<
  typeof ManagedBrowserExecutionLeaseSchema
>;

export class ManagedBrowserTaskStartError extends Error {
  constructor(
    public readonly code: 'BROWSER_TARGET_BUSY' | 'BROWSER_TARGET_TIMEOUT',
  ) {
    super(code);
  }
}

type ExternalActionRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  run_id: string;
  actor_id: string;
  target_id: string | null;
  connector_binding_id: string | null;
  action: string;
  risk:
    'managed_write' | 'external_send' | 'destructive' | 'financial_or_legal';
  status:
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'executing'
    | 'succeeded'
    | 'failed'
    | 'canceled';
  input_digest: string;
  output_digest: string | null;
  approval_id: string | null;
  idempotency_key: string;
  error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
};

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function actorId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function requireWorkspaceMember(context: RequestContext, workspaceId: string) {
  const actor = actorId(context);
  const membership = context.memberships.find(
    (item) =>
      item.active &&
      item.userId === actor &&
      item.organizationId === context.organizationId &&
      (item.workspaceId === null || item.workspaceId === workspaceId),
  );
  if (!membership) throw new DataAccessError('authorization_denied');
  return { actor, membership };
}

function requireWorkspaceAdmin(context: RequestContext, workspaceId: string) {
  const result = requireWorkspaceMember(context, workspaceId);
  if (result.membership.role !== 'admin') {
    throw new DataAccessError('authorization_denied');
  }
  return result.actor;
}

export function projectedExecutionTargetState(input: {
  persistedState: ExecutionTarget['state'];
  kind: ExecutionTarget['kind'];
  lastHeartbeatAt: Date | null;
  now?: Date;
}) {
  if (input.persistedState === 'revoked') return 'revoked' as const;
  if (input.kind === 'cloud_sandbox') return input.persistedState;
  if (!input.lastHeartbeatAt) return 'offline' as const;
  const staleAfterMs = 5 * 60_000;
  const age =
    (input.now ?? new Date()).getTime() - input.lastHeartbeatAt.getTime();
  return age > staleAfterMs ? ('offline' as const) : input.persistedState;
}

function mapTarget(row: TargetRow): ExecutionTarget {
  return ExecutionTargetSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    label: row.label,
    state: projectedExecutionTargetState({
      persistedState: row.state,
      kind: row.kind,
      lastHeartbeatAt: row.last_heartbeat_at,
    }),
    capabilities: row.capabilities,
    concurrencyLimit: row.concurrency_limit,
    timeoutSeconds: row.timeout_seconds,
    lastHeartbeatAt: row.last_heartbeat_at?.toISOString() ?? null,
    unavailableReason: row.unavailable_reason,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function mapBrowserTask(row: BrowserTaskRow): ManagedBrowserTask {
  return ManagedBrowserTaskSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    targetId: row.target_id,
    status: row.status,
    startUrl: row.start_url,
    allowedDomains: row.allowed_domains,
    steps: row.steps,
    evidence: row.evidence,
    artifacts: row.evidence_artifacts ?? [],
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null,
    errorCode: row.error_code,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

function mapBrowserEvidenceArtifact(
  row: BrowserEvidenceArtifactRow,
): ManagedBrowserEvidenceArtifact {
  return ManagedBrowserEvidenceArtifactSchema.parse({
    id: row.id,
    objectId: row.object_id,
    kind: row.kind,
    name: row.name,
    checksum: row.checksum,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at.toISOString(),
  });
}

export function managedBrowserExecutionScopeMatches(input: {
  context: ExecutionContext;
  task: {
    organizationId: string;
    workspaceId: string;
    runId: string;
  };
}) {
  return (
    input.context.workspaceId !== null &&
    input.task.organizationId === input.context.organizationId &&
    input.task.workspaceId === input.context.workspaceId &&
    input.task.runId === input.context.runId
  );
}

export function managedBrowserCompletionStatus(input: {
  requestedStatus: 'succeeded' | 'failed' | 'canceled';
  taskCancelRequestedAt: Date | string | null;
  parentRunState: RunStatus;
  parentJobCanceled: boolean;
}) {
  if (
    input.taskCancelRequestedAt !== null ||
    input.parentRunState === 'canceled' ||
    input.parentJobCanceled
  ) {
    return 'canceled' as const;
  }
  return input.requestedStatus;
}

export function isEquivalentManagedBrowserArtifactReplay(input: {
  existing: {
    taskId: string;
    objectId: string;
    kind: ManagedBrowserEvidenceArtifact['kind'];
    name: string;
  };
  requested: {
    taskId: string;
    objectId: string;
    kind: ManagedBrowserEvidenceArtifact['kind'];
    name: string;
  };
}) {
  return (
    input.existing.taskId === input.requested.taskId &&
    input.existing.objectId === input.requested.objectId &&
    input.existing.kind === input.requested.kind &&
    input.existing.name === input.requested.name
  );
}

/**
 * The terminal evidence document may only reference immutable artifacts that
 * were registered for this exact task. This keeps replay metadata from
 * claiming another task's object or an object whose checksum does not match.
 */
export function validateManagedBrowserEvidenceReferences(input: {
  status: 'succeeded' | 'failed' | 'canceled';
  evidence: ManagedBrowserEvidence[];
  artifacts: ManagedBrowserEvidenceArtifact[];
}) {
  if (input.status === 'succeeded' && input.evidence.length === 0) {
    throw new DataAccessError('authorization_denied');
  }
  const artifactsByObjectId = new Map(
    input.artifacts.map((artifact) => [artifact.objectId, artifact]),
  );
  const requireArtifact = (
    objectId: string,
    kind: ManagedBrowserEvidenceArtifact['kind'],
  ) => {
    const artifact = artifactsByObjectId.get(objectId);
    if (!artifact || artifact.kind !== kind) {
      throw new DataAccessError('authorization_denied');
    }
    return artifact;
  };
  for (const item of input.evidence) {
    if (!item.contentObjectId) {
      throw new DataAccessError('authorization_denied');
    }
    const content = requireArtifact(item.contentObjectId, 'content');
    if (content.checksum !== item.contentChecksum) {
      throw new DataAccessError('authorization_denied');
    }
    if (item.screenshotObjectId) {
      requireArtifact(item.screenshotObjectId, 'screenshot');
    }
    const downloads = new Set(item.downloadObjectIds);
    if (downloads.size !== item.downloadObjectIds.length) {
      throw new DataAccessError('authorization_denied');
    }
    for (const objectId of downloads) {
      requireArtifact(objectId, 'download');
    }
  }
}

export async function registerExecutionTarget(
  context: RequestContext,
  input: unknown,
) {
  const registration = RegisterExecutionTargetInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(
    context,
    registration.workspaceId,
  );
  const actor = requireWorkspaceAdmin(context, workspaceId);
  const sql = getDatabase();
  const rows = await sql<TargetRow[]>`
    insert into allrice_execution_targets (
      organization_id, workspace_id, target_key, kind, label, capabilities,
      concurrency_limit, timeout_seconds, metadata
    ) values (
      ${context.organizationId}, ${workspaceId}, ${registration.targetKey},
      ${registration.kind}, ${registration.label},
      ${sql.json(registration.capabilities)}, ${registration.concurrencyLimit},
      ${registration.timeoutSeconds}, ${sql.json(toJsonValue(registration.metadata))}
    ) on conflict (organization_id, workspace_id, target_key) do update set
      kind = excluded.kind, label = excluded.label,
      capabilities = excluded.capabilities,
      concurrency_limit = excluded.concurrency_limit,
      timeout_seconds = excluded.timeout_seconds,
      metadata = excluded.metadata, updated_at = now()
    returning *
  `;
  const row = rows[0];
  if (!row) throw new Error('execution target registration failed');
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id
    ) values (
      ${context.organizationId}, ${workspaceId}, ${actor},
      'execution_target.register', 'execution_target', ${row.id}, 'allowed',
      ${registration.kind}, ${context.requestId}
    )
  `;
  return mapTarget(row);
}

export async function listExecutionTargets(
  context: RequestContext,
  workspaceIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  requireWorkspaceMember(context, workspaceId);
  const sql = getDatabase();
  const rows = await sql<TargetRow[]>`
    select * from allrice_execution_targets
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
    order by kind, label, id
  `;
  return rows.map(mapTarget);
}

export async function heartbeatExecutionTarget(input: {
  organizationId: string;
  workspaceId: string;
  targetKey: string;
  state?: 'online' | 'degraded';
  unavailableReason?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const sql = getDatabase();
  const rows = await sql<TargetRow[]>`
    update allrice_execution_targets
    set state = ${input.state ?? 'online'}, last_heartbeat_at = now(),
        unavailable_reason = ${input.unavailableReason ?? null},
        metadata = metadata || ${sql.json(toJsonValue(input.metadata ?? {}))},
        updated_at = now()
    where organization_id = ${UuidSchema.parse(input.organizationId)}
      and workspace_id = ${UuidSchema.parse(input.workspaceId)}
      and target_key = ${input.targetKey}
      and state <> 'revoked'
    returning *
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  return mapTarget(row);
}

const BrowserTaskInputSchema = z
  .object({
    runId: UuidSchema,
    targetId: UuidSchema,
    startUrl: z.string().url(),
    allowedDomains: z.array(z.string().trim().min(1).max(253)).min(1),
    steps: z.array(ManagedBrowserStepSchema).max(50).default([]),
    toolCallId: z.string().trim().min(1).max(255),
  })
  .strict();

export async function createManagedBrowserTask(
  context: ExecutionContext,
  input: unknown,
  leaseInput: ManagedBrowserExecutionLease,
) {
  const task = BrowserTaskInputSchema.parse(input);
  const lease = ManagedBrowserExecutionLeaseSchema.parse(leaseInput);
  if (
    !context.workspaceId ||
    task.runId !== context.runId ||
    !managedBrowserExecutionScopeMatches({
      context,
      task: {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        runId: task.runId,
      },
    })
  ) {
    throw new DataAccessError('authorization_denied');
  }
  const hostname = new URL(task.startUrl).hostname.toLowerCase();
  if (
    !task.allowedDomains.some((domain) => {
      const normalized = domain.toLowerCase();
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    })
  ) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<BrowserTaskRow[]>`
    insert into allrice_managed_browser_tasks (
      organization_id, workspace_id, run_id, job_id, job_attempt,
      tool_call_id, target_id, start_url, allowed_domains, steps
    ) select
      ${context.organizationId}, ${context.workspaceId}, ${task.runId},
      job.id, job.attempt, ${task.toolCallId}, t.id, ${task.startUrl},
      ${sql.json(task.allowedDomains)},
      ${sql.json(task.steps)}
    from allrice_execution_targets t
    join allrice_runs run
      on run.id = ${context.runId}
     and run.organization_id = t.organization_id
     and run.workspace_id = t.workspace_id
     and run.owner_id = ${context.policySnapshot.subjectId}
     and run.state in ('queued', 'running')
    join allrice_jobs job
      on job.id = ${context.jobId}
     and job.organization_id = run.organization_id
     and job.workspace_id = run.workspace_id
     and job.run_id = run.id
     and job.attempt = ${lease.attempt}
     and job.lease_token = ${lease.leaseToken}
     and job.worker_id = ${context.worker.id}
     and job.lease_expires_at > now()
     and job.cancel_requested_at is null
     and job.status = 'running'
    where t.id = ${task.targetId}
      and t.organization_id = ${context.organizationId}
      and t.workspace_id = ${context.workspaceId}
      and t.kind = 'cloud_sandbox'
      and t.capabilities ? 'browser.navigate'
      and t.state in ('online', 'degraded')
    on conflict (
      organization_id, workspace_id, job_id, job_attempt, tool_call_id
    ) do nothing
    returning *
  `;
  const existingRows = rows[0]
    ? []
    : await sql<BrowserTaskRow[]>`
        select browser_task.*
        from allrice_managed_browser_tasks browser_task
        join allrice_runs run
          on run.id = browser_task.run_id
         and run.organization_id = browser_task.organization_id
         and run.workspace_id = browser_task.workspace_id
         and run.owner_id = ${context.policySnapshot.subjectId}
         and run.state in ('queued', 'running')
        join allrice_jobs job
          on job.id = browser_task.job_id
         and job.id = ${context.jobId}
         and job.organization_id = browser_task.organization_id
         and job.workspace_id = browser_task.workspace_id
         and job.run_id = browser_task.run_id
         and job.attempt = browser_task.job_attempt
         and job.attempt = ${lease.attempt}
         and job.lease_token = ${lease.leaseToken}
         and job.worker_id = ${context.worker.id}
         and job.lease_expires_at > now()
         and job.cancel_requested_at is null
         and job.status = 'running'
        join allrice_execution_targets target
          on target.id = browser_task.target_id
         and target.organization_id = browser_task.organization_id
         and target.workspace_id = browser_task.workspace_id
         and target.kind = 'cloud_sandbox'
         and target.capabilities ? 'browser.navigate'
         and target.state in ('online', 'degraded')
        where browser_task.organization_id = ${context.organizationId}
          and browser_task.workspace_id = ${context.workspaceId}
          and browser_task.run_id = ${context.runId}
          and browser_task.job_id = ${context.jobId}
          and browser_task.job_attempt = ${lease.attempt}
          and browser_task.tool_call_id = ${task.toolCallId}
        limit 1
      `;
  const row = rows[0] ?? existingRows[0];
  if (!row) throw new DataAccessError('authorization_denied');
  if (
    row.run_id !== task.runId ||
    row.target_id !== task.targetId ||
    row.start_url !== task.startUrl ||
    canonical(row.allowed_domains) !== canonical(task.allowedDomains) ||
    canonical(row.steps) !== canonical(task.steps)
  ) {
    throw new DataAccessError('authorization_denied');
  }
  return mapBrowserTask(row);
}

export async function createDefaultManagedBrowserTask(
  context: ExecutionContext,
  startUrl: string,
  steps: z.infer<typeof ManagedBrowserStepSchema>[] = [],
  lease: ManagedBrowserExecutionLease,
  toolCallId: string,
) {
  const hostname = new URL(startUrl).hostname.toLowerCase();
  const sql = getDatabase();
  const rows = await sql<{ id: string }[]>`
    select id from allrice_execution_targets
    where organization_id = ${context.organizationId}
      and workspace_id = ${context.workspaceId}
      and target_key = 'cloud.default'
      and kind = 'cloud_sandbox'
      and capabilities ? 'browser.navigate'
      and state in ('online', 'degraded')
    limit 1
  `;
  const target = rows[0];
  if (!target) throw new DataAccessError('authorization_denied');
  return createManagedBrowserTask(
    context,
    {
      runId: context.runId,
      targetId: target.id,
      startUrl,
      allowedDomains: [hostname],
      steps,
      toolCallId,
    },
    lease,
  );
}

export async function startManagedBrowserTask(input: {
  context: ExecutionContext;
  taskId: string;
  lease: ManagedBrowserExecutionLease;
}) {
  const taskId = UuidSchema.parse(input.taskId);
  const lease = ManagedBrowserExecutionLeaseSchema.parse(input.lease);
  const sql = getDatabase();
  const outcome = await sql.begin(async (transaction) => {
    const rows = await transaction<
      (BrowserTaskRow & {
        target_concurrency_limit: number;
        target_timeout_seconds: number;
      })[]
    >`
      select task.*,
             target.concurrency_limit as target_concurrency_limit,
             target.timeout_seconds as target_timeout_seconds
      from allrice_managed_browser_tasks task
      join allrice_execution_targets target
        on target.id = task.target_id
       and target.organization_id = task.organization_id
       and target.workspace_id = task.workspace_id
      join allrice_runs run
        on run.id = task.run_id
       and run.organization_id = task.organization_id
       and run.workspace_id = task.workspace_id
      join allrice_jobs job
        on job.id = task.job_id
       and job.organization_id = task.organization_id
       and job.workspace_id = task.workspace_id
       and job.run_id = task.run_id
      where task.id = ${taskId}
        and task.organization_id = ${input.context.organizationId}
        and task.workspace_id = ${input.context.workspaceId}
        and task.run_id = ${input.context.runId}
        and task.job_id = ${input.context.jobId}
        and task.job_attempt = ${lease.attempt}
        and task.status = 'queued'
        and task.cancel_requested_at is null
        and run.owner_id = ${input.context.policySnapshot.subjectId}
        and run.state in ('queued', 'running')
        and job.attempt = ${lease.attempt}
        and job.lease_token = ${lease.leaseToken}
        and job.worker_id = ${input.context.worker.id}
        and job.lease_expires_at > now()
        and job.cancel_requested_at is null
        and job.status = 'running'
        and target.kind = 'cloud_sandbox'
        and target.capabilities ? 'browser.navigate'
        and target.state in ('online', 'degraded')
      for update of task, target, job
    `;
    const current = rows[0];
    if (!current) return { kind: 'not_found' as const };

    const deadlineAt = new Date(
      current.created_at.getTime() + current.target_timeout_seconds * 1_000,
    );
    if (deadlineAt.getTime() <= Date.now()) {
      await transaction`
        update allrice_managed_browser_tasks
        set status = 'failed', started_at = coalesce(started_at, created_at),
            error_code = 'BROWSER_TARGET_TIMEOUT', completed_at = now()
        where id = ${taskId} and status = 'queued'
      `;
      return { kind: 'timeout' as const };
    }

    const counts = await transaction<{ running_count: number }[]>`
      select count(*)::integer as running_count
      from allrice_managed_browser_tasks
      where organization_id = ${input.context.organizationId}
        and workspace_id = ${input.context.workspaceId}
        and target_id = ${current.target_id}
        and status = 'running'
    `;
    if ((counts[0]?.running_count ?? 0) >= current.target_concurrency_limit) {
      await transaction`
        update allrice_managed_browser_tasks
        set status = 'failed', started_at = coalesce(started_at, created_at),
            error_code = 'BROWSER_TARGET_BUSY', completed_at = now()
        where id = ${taskId} and status = 'queued'
      `;
      return { kind: 'busy' as const };
    }

    const started = await transaction<BrowserTaskRow[]>`
      update allrice_managed_browser_tasks
      set status = 'running', started_at = coalesce(started_at, now())
      where id = ${taskId} and status = 'queued'
      returning *
    `;
    const row = started[0];
    if (!row) return { kind: 'not_found' as const };
    return {
      kind: 'started' as const,
      task: mapBrowserTask(row),
      deadlineAt: deadlineAt.toISOString(),
    };
  });
  if (outcome.kind === 'busy') {
    throw new ManagedBrowserTaskStartError('BROWSER_TARGET_BUSY');
  }
  if (outcome.kind === 'timeout') {
    throw new ManagedBrowserTaskStartError('BROWSER_TARGET_TIMEOUT');
  }
  if (outcome.kind === 'not_found') throw new DataAccessError('not_found');
  return { task: outcome.task, deadlineAt: outcome.deadlineAt };
}

/**
 * Lets an in-flight browser driver observe task-scoped cancellation without
 * trusting an identifier outside the frozen execution tenant boundary.
 */
export async function isManagedBrowserTaskCancelRequested(input: {
  organizationId: string;
  workspaceId: string;
  runId: string;
  taskId: string;
}) {
  const sql = getDatabase();
  const rows = await sql<
    { cancel_requested_at: Date | null; status: BrowserTaskRow['status'] }[]
  >`
    select cancel_requested_at, status
    from allrice_managed_browser_tasks
    where id = ${UuidSchema.parse(input.taskId)}
      and organization_id = ${UuidSchema.parse(input.organizationId)}
      and workspace_id = ${UuidSchema.parse(input.workspaceId)}
      and run_id = ${UuidSchema.parse(input.runId)}
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  return {
    requested: row.cancel_requested_at !== null || row.status === 'canceled',
    requestedAt: row.cancel_requested_at?.toISOString() ?? null,
    status: row.status,
  };
}

export async function requestManagedBrowserTaskCancel(
  context: RequestContext,
  workspaceIdInput: string,
  taskIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const { actor } = requireWorkspaceMember(context, workspaceId);
  const taskId = UuidSchema.parse(taskIdInput);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const rows = await transaction<BrowserTaskRow[]>`
      select task.*
      from allrice_managed_browser_tasks task
      join allrice_runs run
        on run.id = task.run_id
       and run.organization_id = task.organization_id
       and run.workspace_id = task.workspace_id
      where task.id = ${taskId}
        and task.organization_id = ${context.organizationId}
        and task.workspace_id = ${workspaceId}
        and run.owner_id = ${actor}
      for update of task
    `;
    const current = rows[0];
    if (!current) throw new DataAccessError('not_found');
    if (['succeeded', 'failed', 'canceled'].includes(current.status)) {
      return mapBrowserTask(current);
    }
    const updated = await transaction<BrowserTaskRow[]>`
      update allrice_managed_browser_tasks
      set cancel_requested_at = coalesce(cancel_requested_at, now()),
          status = case when status = 'queued' then 'canceled' else status end,
          error_code = case
            when status = 'queued' then 'BROWSER_TASK_CANCELED'
            else error_code
          end,
          completed_at = case
            when status = 'queued' then coalesce(completed_at, now())
            else completed_at
          end
      where id = ${taskId}
        and organization_id = ${context.organizationId}
        and workspace_id = ${workspaceId}
        and status in ('queued', 'running')
      returning *
    `;
    const row = updated[0];
    if (!row) throw new DataAccessError('not_found');
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, request_id
      ) values (
        ${context.organizationId}, ${workspaceId}, ${actor},
        'managed_browser.cancel', 'managed_browser_task', ${taskId},
        'allowed', 'run_owner', ${context.requestId}
      )
    `;
    return mapBrowserTask(row);
  });
}

const BrowserEvidenceArtifactInputSchema = z
  .object({
    id: UuidSchema,
    key: ObjectKeySchema,
    checksum: StorageObjectSchema.shape.checksum,
    mediaType: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export async function registerManagedBrowserEvidenceArtifact(input: {
  context: ExecutionContext;
  lease: ManagedBrowserExecutionLease;
  taskId: string;
  kind: 'content' | 'screenshot' | 'download';
  name: string;
  object: z.input<typeof BrowserEvidenceArtifactInputSchema>;
}) {
  if (!input.context.workspaceId) {
    throw new DataAccessError('authorization_denied');
  }
  const taskId = UuidSchema.parse(input.taskId);
  const lease = ManagedBrowserExecutionLeaseSchema.parse(input.lease);
  const object = BrowserEvidenceArtifactInputSchema.parse(input.object);
  const name = z.string().trim().min(1).max(255).parse(input.name);
  const kind = z.enum(['content', 'screenshot', 'download']).parse(input.kind);
  const ownerId = input.context.policySnapshot.subjectId;
  const expectedKey = makeObjectKey({
    organizationId: input.context.organizationId,
    workspaceId: input.context.workspaceId,
    ownerId,
    category: 'artifacts',
    objectId: object.id,
  });
  if (object.key !== expectedKey) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    await lockWorkspaceStorageQuota(
      transaction,
      input.context.organizationId,
      input.context.workspaceId,
    );
    const tasks = await transaction<{ id: string }[]>`
      select task.id
      from allrice_managed_browser_tasks task
      join allrice_runs run
        on run.id = task.run_id
       and run.organization_id = task.organization_id
       and run.workspace_id = task.workspace_id
      join allrice_execution_targets target
        on target.id = task.target_id
       and target.organization_id = task.organization_id
       and target.workspace_id = task.workspace_id
      where task.id = ${taskId}
        and task.organization_id = ${input.context.organizationId}
        and task.workspace_id = ${input.context.workspaceId}
        and task.run_id = ${input.context.runId}
        and task.status = 'running'
        and task.cancel_requested_at is null
        and run.owner_id = ${ownerId}
        and run.state in ('queued', 'running')
        and exists (
          select 1
          from allrice_jobs job
          where job.id = task.job_id
            and job.id = ${input.context.jobId}
            and job.organization_id = task.organization_id
            and job.workspace_id = task.workspace_id
            and job.run_id = task.run_id
            and job.attempt = task.job_attempt
            and job.attempt = ${lease.attempt}
            and job.lease_token = ${lease.leaseToken}
            and job.worker_id = ${input.context.worker.id}
            and job.lease_expires_at > now()
            and job.cancel_requested_at is null
            and job.status = 'running'
        )
        and target.kind = 'cloud_sandbox'
        and target.capabilities ? 'artifacts.write'
      for update of task
    `;
    if (!tasks[0]) throw new DataAccessError('authorization_denied');
    const existingObjects = await transaction<
      {
        id: string;
        object_key: string;
        checksum: string;
        media_type: string;
        size_bytes: number | string;
      }[]
    >`
      select id, object_key, checksum, media_type, size_bytes
      from allrice_storage_objects
      where id = ${object.id}
        and organization_id = ${input.context.organizationId}
        and workspace_id = ${input.context.workspaceId}
        and owner_id = ${ownerId}
        and category = 'artifacts'
        and visibility = 'private'
        and state = 'ready'
        and immutable
    `;
    const existingObject = existingObjects[0];
    if (
      existingObject &&
      (existingObject.object_key !== object.key ||
        existingObject.checksum !== object.checksum ||
        existingObject.media_type !== object.mediaType ||
        Number(existingObject.size_bytes) !== object.sizeBytes)
    ) {
      throw new DataAccessError('authorization_denied');
    }
    const quotas = await transaction<
      { limit_bytes: number | string; used_bytes: number | string }[]
    >`
      select
        coalesce(q.limit_bytes, ${defaultWorkspaceQuotaBytes}) as limit_bytes,
        coalesce(sum(stored.size_bytes) filter (
          where stored.state <> 'deleted'
        ), 0) as used_bytes
      from allrice_workspaces workspace
      left join allrice_storage_quotas q
        on q.organization_id = workspace.organization_id
       and q.workspace_id = workspace.id
      left join allrice_storage_objects stored
        on stored.organization_id = workspace.organization_id
       and stored.workspace_id = workspace.id
      where workspace.organization_id = ${input.context.organizationId}
        and workspace.id = ${input.context.workspaceId}
      group by q.limit_bytes
    `;
    const quota = quotas[0];
    if (
      !quota ||
      Number(quota.used_bytes) + (existingObject ? 0 : object.sizeBytes) >
        Number(quota.limit_bytes)
    ) {
      throw new DataAccessError('quota_exceeded');
    }
    const inserted = existingObject
      ? []
      : await transaction<
          {
            id: string;
            object_key: string;
            checksum: string;
            media_type: string;
            size_bytes: number | string;
          }[]
        >`
          insert into allrice_storage_objects (
            id, organization_id, workspace_id, owner_id, object_key, category,
            media_type, size_bytes, checksum, visibility, state, immutable
          ) values (
            ${object.id}, ${input.context.organizationId},
            ${input.context.workspaceId}, ${ownerId}, ${object.key}, 'artifacts',
            ${object.mediaType}, ${object.sizeBytes}, ${object.checksum},
            'private', 'ready', true
          )
          returning id, object_key, checksum, media_type, size_bytes
        `;
    const storedObject = existingObject ?? inserted[0];
    if (
      !storedObject ||
      storedObject.object_key !== object.key ||
      storedObject.checksum !== object.checksum ||
      storedObject.media_type !== object.mediaType ||
      Number(storedObject.size_bytes) !== object.sizeBytes
    ) {
      throw new DataAccessError('authorization_denied');
    }
    const existingArtifacts = await transaction<
      {
        id: string;
        task_id: string;
        object_id: string;
        kind: ManagedBrowserEvidenceArtifact['kind'];
        name: string;
        created_at: Date;
      }[]
    >`
      select id, task_id, object_id, kind, name, created_at
      from allrice_managed_browser_evidence_artifacts
      where organization_id = ${input.context.organizationId}
        and workspace_id = ${input.context.workspaceId}
        and object_id = ${object.id}
    `;
    const existingArtifact = existingArtifacts[0];
    if (
      existingArtifact &&
      !isEquivalentManagedBrowserArtifactReplay({
        existing: {
          taskId: existingArtifact.task_id,
          objectId: existingArtifact.object_id,
          kind: existingArtifact.kind,
          name: existingArtifact.name,
        },
        requested: { taskId, objectId: object.id, kind, name },
      })
    ) {
      throw new DataAccessError('authorization_denied');
    }
    const insertedArtifacts = existingArtifact
      ? []
      : await transaction<{ id: string; created_at: Date }[]>`
      insert into allrice_managed_browser_evidence_artifacts (
        organization_id, workspace_id, task_id, object_id, kind, name
      ) values (
        ${input.context.organizationId}, ${input.context.workspaceId},
        ${taskId}, ${object.id}, ${kind}, ${name}
      ) on conflict do nothing
      returning id, created_at
    `;
    const artifact = existingArtifact ?? insertedArtifacts[0];
    if (!artifact) throw new Error('browser evidence artifact creation failed');
    return {
      id: artifact.id,
      taskId,
      objectId: object.id,
      kind,
      name,
      checksum: object.checksum,
      createdAt: artifact.created_at.toISOString(),
    };
  });
}

export async function completeManagedBrowserTask(input: {
  context: ExecutionContext;
  lease: ManagedBrowserExecutionLease;
  taskId: string;
  status: 'succeeded' | 'failed' | 'canceled';
  evidence?: z.input<typeof ManagedBrowserEvidenceSchema>[];
  errorCode?: string | null;
}) {
  if (!input.context.workspaceId) {
    throw new DataAccessError('authorization_denied');
  }
  const evidence = z
    .array(ManagedBrowserEvidenceSchema)
    .parse(input.evidence ?? []);
  const errorCode = z
    .string()
    .max(160)
    .nullable()
    .parse(input.errorCode ?? null);
  const sql = getDatabase();
  const taskId = UuidSchema.parse(input.taskId);
  const lease = ManagedBrowserExecutionLeaseSchema.parse(input.lease);
  return sql.begin(async (transaction) => {
    const rows = await transaction<
      (BrowserTaskRow & {
        parent_run_state: RunStatus;
        parent_job_cancel_requested_at: Date | null;
        parent_job_status: string;
      })[]
    >`
      select task.*, run.state as parent_run_state,
             job.cancel_requested_at as parent_job_cancel_requested_at,
             job.status as parent_job_status
      from allrice_managed_browser_tasks task
      join allrice_runs run
        on run.id = task.run_id
       and run.organization_id = task.organization_id
       and run.workspace_id = task.workspace_id
      join allrice_jobs job
        on job.id = task.job_id
       and job.id = ${input.context.jobId}
       and job.organization_id = task.organization_id
       and job.workspace_id = task.workspace_id
       and job.run_id = task.run_id
       and job.attempt = task.job_attempt
       and job.attempt = ${lease.attempt}
       and job.lease_token = ${lease.leaseToken}
       and job.worker_id = ${input.context.worker.id}
       and job.lease_expires_at > now()
      where task.id = ${taskId}
        and task.organization_id = ${input.context.organizationId}
        and task.workspace_id = ${input.context.workspaceId}
        and task.run_id = ${input.context.runId}
        and run.owner_id = ${input.context.policySnapshot.subjectId}
      for update of task, run, job
    `;
    const current = rows[0];
    if (!current || current.status === 'queued') {
      throw new DataAccessError('not_found');
    }
    const artifactRows = await transaction<BrowserEvidenceArtifactRow[]>`
      select artifact.id, artifact.task_id, artifact.object_id, artifact.kind,
             artifact.name, stored.checksum, stored.media_type,
             stored.size_bytes, artifact.created_at
      from allrice_managed_browser_evidence_artifacts artifact
      join allrice_storage_objects stored
        on stored.id = artifact.object_id
       and stored.organization_id = artifact.organization_id
       and stored.workspace_id = artifact.workspace_id
      where artifact.organization_id = ${input.context.organizationId}
        and artifact.workspace_id = ${input.context.workspaceId}
        and artifact.task_id = ${taskId}
        and stored.owner_id = ${input.context.policySnapshot.subjectId}
        and stored.category = 'artifacts'
        and stored.visibility = 'private'
        and stored.state = 'ready'
        and stored.immutable
      order by artifact.created_at, artifact.id
    `;
    const artifacts = artifactRows.map(mapBrowserEvidenceArtifact);
    const finalStatus = managedBrowserCompletionStatus({
      requestedStatus: input.status,
      taskCancelRequestedAt: current.cancel_requested_at,
      parentRunState: current.parent_run_state,
      parentJobCanceled:
        current.parent_job_cancel_requested_at !== null ||
        current.parent_job_status === 'canceled',
    });
    validateManagedBrowserEvidenceReferences({
      status: finalStatus,
      evidence,
      artifacts,
    });
    const finalErrorCode =
      finalStatus === 'canceled' ? 'BROWSER_TASK_CANCELED' : errorCode;
    if (current.status !== 'running') {
      if (
        current.status !== finalStatus ||
        canonical(current.evidence) !== canonical(evidence) ||
        current.error_code !== finalErrorCode
      ) {
        throw new DataAccessError('not_found');
      }
      return mapBrowserTask({
        ...current,
        evidence_artifacts: artifacts,
      });
    }
    const updated = await transaction<BrowserTaskRow[]>`
      update allrice_managed_browser_tasks
      set status = ${finalStatus}, evidence = ${transaction.json(evidence)},
          error_code = ${finalErrorCode}, completed_at = now()
      where id = ${taskId}
        and organization_id = ${input.context.organizationId}
        and workspace_id = ${input.context.workspaceId}
        and run_id = ${input.context.runId}
        and status = 'running'
      returning *
    `;
    const row = updated[0];
    if (!row) throw new DataAccessError('not_found');
    return mapBrowserTask({ ...row, evidence_artifacts: artifacts });
  });
}

export async function listManagedBrowserTasks(
  context: RequestContext,
  workspaceIdInput: string,
  options: { runId?: string; limit?: number } = {},
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const { actor, membership } = requireWorkspaceMember(context, workspaceId);
  const runId = options.runId ? UuidSchema.parse(options.runId) : null;
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(options.limit ?? 100);
  const sql = getDatabase();
  const rows = await sql<BrowserTaskRow[]>`
    select t.*, coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', artifact.id,
          'objectId', artifact.object_id,
          'kind', artifact.kind,
          'name', artifact.name,
          'checksum', stored.checksum,
          'mediaType', stored.media_type,
          'sizeBytes', stored.size_bytes,
          'createdAt', artifact.created_at
        ) order by artifact.created_at, artifact.id
      )
      from allrice_managed_browser_evidence_artifacts artifact
      join allrice_storage_objects stored
        on stored.id = artifact.object_id
       and stored.organization_id = artifact.organization_id
       and stored.workspace_id = artifact.workspace_id
      where artifact.organization_id = t.organization_id
        and artifact.workspace_id = t.workspace_id
        and artifact.task_id = t.id
        and stored.category = 'artifacts'
        and stored.visibility = 'private'
        and stored.state = 'ready'
        and stored.immutable
    ), '[]'::jsonb) as evidence_artifacts
    from allrice_managed_browser_tasks t
    join allrice_runs r
      on r.organization_id = t.organization_id
     and r.workspace_id = t.workspace_id
     and r.id = t.run_id
    where t.organization_id = ${context.organizationId}
      and t.workspace_id = ${workspaceId}
      and (${runId}::uuid is null or t.run_id = ${runId})
      and (
        ${membership.role === 'admin'}
        or r.owner_id = ${actor}
        or r.visibility <> 'private'
      )
    order by t.created_at desc, t.id desc
    limit ${limit}
  `;
  return rows.map(mapBrowserTask);
}

export async function getManagedBrowserTask(
  context: RequestContext,
  workspaceIdInput: string,
  taskIdInput: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const { actor, membership } = requireWorkspaceMember(context, workspaceId);
  const sql = getDatabase();
  const rows = await sql<BrowserTaskRow[]>`
    select task.*, coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', artifact.id,
          'objectId', artifact.object_id,
          'kind', artifact.kind,
          'name', artifact.name,
          'checksum', stored.checksum,
          'mediaType', stored.media_type,
          'sizeBytes', stored.size_bytes,
          'createdAt', artifact.created_at
        ) order by artifact.created_at, artifact.id
      )
      from allrice_managed_browser_evidence_artifacts artifact
      join allrice_storage_objects stored
        on stored.id = artifact.object_id
       and stored.organization_id = artifact.organization_id
       and stored.workspace_id = artifact.workspace_id
      where artifact.organization_id = task.organization_id
        and artifact.workspace_id = task.workspace_id
        and artifact.task_id = task.id
        and stored.category = 'artifacts'
        and stored.visibility = 'private'
        and stored.state = 'ready'
        and stored.immutable
    ), '[]'::jsonb) as evidence_artifacts
    from allrice_managed_browser_tasks task
    join allrice_runs run
      on run.id = task.run_id
     and run.organization_id = task.organization_id
     and run.workspace_id = task.workspace_id
    where task.id = ${UuidSchema.parse(taskIdInput)}
      and task.organization_id = ${context.organizationId}
      and task.workspace_id = ${workspaceId}
      and (
        ${membership.role === 'admin'}
        or run.owner_id = ${actor}
        or run.visibility <> 'private'
      )
    limit 1
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  return mapBrowserTask(row);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function externalActionDigest(value: unknown) {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export function isEquivalentExternalActionReplay(input: {
  existing: {
    organizationId: string;
    workspaceId: string;
    runId: string;
    actorId: string;
    action: string;
    inputDigest: string;
  };
  requested: {
    organizationId: string;
    workspaceId: string;
    runId: string;
    actorId: string;
    action: string;
    inputDigest: string;
  };
}) {
  return Object.entries(input.requested).every(
    ([key, value]) =>
      input.existing[key as keyof typeof input.existing] === value,
  );
}

export async function prepareExternalAction(input: {
  context: ExecutionContext;
  action: string;
  risk: z.infer<typeof ExternalActionRiskSchema>;
  payload: unknown;
  idempotencyKey: string;
  targetId?: string | null;
  connectorBindingId?: string | null;
}) {
  const workspaceId = input.context.workspaceId;
  if (!workspaceId) throw new Error('workspace is required');
  const risk = ExternalActionRiskSchema.parse(input.risk);
  const actionId = randomUUID();
  const approvalId = randomUUID();
  const digest = externalActionDigest(input.payload);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const rows = await transaction<ExternalActionRow[]>`
      insert into allrice_external_actions (
        id, organization_id, workspace_id, run_id, actor_id, target_id,
        connector_binding_id, action, risk, input_digest, idempotency_key
      ) values (
        ${actionId}, ${input.context.organizationId},
        ${workspaceId}, ${input.context.runId},
        ${input.context.policySnapshot.subjectId}, ${input.targetId ?? null},
        ${input.connectorBindingId ?? null}, ${input.action}, ${risk},
        ${digest}, ${input.idempotencyKey}
      ) on conflict (organization_id, idempotency_key) do update
      set idempotency_key = excluded.idempotency_key
      returning *
    `;
    const action = rows[0];
    if (!action) throw new Error('external action preparation failed');
    if (
      !isEquivalentExternalActionReplay({
        existing: {
          organizationId: action.organization_id,
          workspaceId: action.workspace_id,
          runId: action.run_id,
          actorId: action.actor_id,
          action: action.action,
          inputDigest: action.input_digest,
        },
        requested: {
          organizationId: input.context.organizationId,
          workspaceId,
          runId: input.context.runId,
          actorId: input.context.policySnapshot.subjectId,
          action: input.action,
          inputDigest: digest,
        },
      })
    ) {
      throw new DataAccessError('authorization_denied');
    }
    if (action.id !== actionId) {
      return {
        id: action.id,
        approvalId: action.approval_id,
        status: action.status,
        digest: action.input_digest,
        replayed: true as const,
      };
    }
    await transaction`
      insert into allrice_approval_requests (
        id, organization_id, workspace_id, run_id, actor_id,
        resource_type, resource_id, action, input_digest
      ) values (
        ${approvalId}, ${input.context.organizationId},
        ${workspaceId}, ${input.context.runId},
        ${input.context.policySnapshot.subjectId}, 'external_action',
        ${actionId}, ${input.action}, ${digest}
      )
    `;
    await transaction`
      update allrice_external_actions
      set approval_id = ${approvalId}
      where id = ${actionId}
    `;
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, metadata
      ) values (
        ${input.context.organizationId}, ${workspaceId},
        ${input.context.policySnapshot.subjectId}, 'external_action.prepare',
        'external_action', ${actionId}, 'pending',
        'explicit_confirmation_required',
        ${transaction.json({ action: input.action, risk, digest })}
      )
    `;
    return {
      id: actionId,
      approvalId,
      status: 'pending_approval' as const,
      digest,
      replayed: false as const,
    };
  });
}

export async function listExternalActions(
  context: RequestContext,
  workspaceIdInput: string,
  options: { runId?: string; limit?: number } = {},
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const { actor, membership } = requireWorkspaceMember(context, workspaceId);
  const runId = options.runId ? UuidSchema.parse(options.runId) : null;
  const limit = z
    .number()
    .int()
    .min(1)
    .max(200)
    .parse(options.limit ?? 100);
  const sql = getDatabase();
  const rows = await sql<ExternalActionRow[]>`
    select * from allrice_external_actions
    where organization_id = ${context.organizationId}
      and workspace_id = ${workspaceId}
      and (${runId}::uuid is null or run_id = ${runId})
      and (${membership.role === 'admin'} or actor_id = ${actor})
    order by created_at desc, id desc
    limit ${limit}
  `;
  return rows.map((row) =>
    ExternalActionSchema.parse({
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      runId: row.run_id,
      actorId: row.actor_id,
      targetId: row.target_id,
      connectorBindingId: row.connector_binding_id,
      action: row.action,
      risk: row.risk,
      status: row.status,
      inputDigest: row.input_digest,
      outputDigest: row.output_digest,
      approvalId: row.approval_id,
      idempotencyKey: row.idempotency_key,
      errorCode: row.error_code,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    }),
  );
}
