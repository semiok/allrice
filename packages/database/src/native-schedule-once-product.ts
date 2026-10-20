import { employeeAccessTransaction } from './employees/employee-access-cancellation.ts';
import { explicitOnceTaskIntent } from './employees/once-task-intent.ts';
import { randomUUID } from 'node:crypto';
import { realpath, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  employeeChatIdentity,
  employeeChatUuid,
  assertEmployeeChatExecution,
  type EmployeeChatCall,
} from './employees/employee-chat-authority.ts';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import {
  CreateOnceTaskInputSchema,
  OnceTaskSchema,
  OnceTaskListQuerySchema,
  RequestContextSchema,
  UuidSchema,
  MembershipSchema,
  TimestampSchema,
  type CreateOnceTaskInput,
  type OnceTask,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { readWorkAutomation } from './work-automation.ts';
import { assertWorkbenchSession } from './artifact-review.ts';
import { resolveEmployeeSessionInstance } from './employees/employee-instances.ts';
import type { ResourcePrincipal } from './resource-principal.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { acquireDevAdmission } from './dev-maintenance.ts';
import {
  nativeOnceDigest,
  nativeOnceReady,
  type NativeOnceControl,
  type NativeOnceReference,
  type NativeOnceReadiness,
} from './native-schedule-once-state.ts';
import type { NativeOnceLockedAdmission } from './native-schedule-once-sql.ts';

type Tx = TransactionSql;
type Scope = { organizationId: string; workspaceId: string; ownerId: string };
type Target = {
  id: string;
  employee_assignment_id: string;
  employee_instance_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
};
type Plan = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  employee_assignment_id: string;
  session_id: string;
  name: string;
  prompt: string;
  schedule: { runAt: string; timezone: string };
  status: 'enabled' | 'paused';
  clock_owner: string;
  revision: number;
  native_once_request_id: string;
  native_once_request_digest: string;
  native_once_cancelled_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
};
type ControlRow = {
  partition_id: string;
  control_id: string;
  snapshot: { control: NativeOnceControl; task: unknown };
};

export class NativeOnceProductError extends Error {
  constructor(
    readonly code:
      | 'disabled'
      | 'time_invalid'
      | 'intent_required'
      | 'time_mismatch'
      | 'request_conflict'
      | 'binding_conflict'
      | 'lease_lost',
  ) {
    super(`native_once_${code}`);
  }
}
export const nativeOnceProductEnabled = () =>
  process.env.ALLRICE_NATIVE_ONCE_ENABLED === '1';
const identity = (s: Scope) => ({
  actor: { type: 'user' as const, id: s.ownerId },
  organizationId: s.organizationId,
  workspaceId: s.workspaceId,
});
const json = (tx: Tx, v: unknown) => tx.json(JSON.parse(JSON.stringify(v)));

/** Current rows, not a synthetic browser session or a saved membership list. */
async function lockPrincipal(
  tx: Tx,
  scope: Scope,
  requestId: string,
  browser?: RequestContext,
): Promise<ResourcePrincipal> {
  for (const v of Object.values(scope)) UuidSchema.parse(v);
  const current = await readContentPrincipal(
    browser ?? identity(scope),
    tx,
    'update_user',
  );
  if (!current?.writable) throw new DataAccessError('authorization_denied');
  const rows = await tx<
    {
      id: string;
      user_id: string;
      organization_id: string;
      workspace_id: string | null;
      role: string;
      active: boolean;
    }[]
  >`
    select id,user_id,organization_id,workspace_id,role,active from allrice_memberships
    where organization_id=${scope.organizationId} and user_id=${scope.ownerId} and active
      and (workspace_id is null or workspace_id=${scope.workspaceId}) order by id for share`;
  return {
    ...identity(scope),
    requestId,
    memberships: rows.map((r) =>
      MembershipSchema.parse({
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id,
        workspaceId: r.workspace_id,
        role: r.role,
        active: r.active,
      }),
    ),
  };
}

async function targetMetadata(tx: Tx, scope: Scope, sessionId: string) {
  const [row] = await tx<Target[]>`
    select id,organization_id,workspace_id,owner_id,employee_assignment_id,
      coalesce(employee_instance_id,employee_assignment_id) employee_instance_id
    from allrice_chat_sessions where id=${UuidSchema.parse(sessionId)}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and archived_at is null`;
  if (!row) throw new DataAccessError('not_found');
  return row;
}

async function lockTarget(tx: Tx, scope: Scope, target: Target) {
  const instance = await resolveEmployeeSessionInstance(
    identity(scope),
    target.employee_assignment_id,
    target.employee_instance_id,
    tx,
  );
  await assertWorkbenchSession(tx, identity(scope), target.id, true);
  // This lane is for ordinary work. Privileged platform drivers keep their own
  // existing authorization and cannot be scheduled by copying their IDs.
  const [ordinary] = await tx`
    select a.id from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    where a.id=${target.employee_assignment_id} and a.organization_id=${scope.organizationId}
      and a.workspace_id=${scope.workspaceId} and a.user_id=${scope.ownerId} and a.active and e.status='active'
      and e.employee_key not like 'platform-%' for share of a,e`;
  if (!ordinary || instance.id !== target.employee_instance_id)
    throw new DataAccessError('authorization_denied');
  return instance;
}

function reservation(p: Plan, c: NativeOnceControl) {
  return runtimePolicyDigest({
    organizationId: p.organization_id,
    workspaceId: p.workspace_id,
    ownerId: p.owner_id,
    assignmentId: p.employee_assignment_id,
    instanceId: c.dispatch.employeeInstanceId,
    sessionId: p.session_id,
    name: p.name,
    prompt: p.prompt,
    runAt: p.schedule.runAt,
    timezone: p.schedule.timezone,
    revision: p.revision,
  });
}

/** Called by Host SQL before partition/control locks. Missing authority records
 * a blocked receipt; it never makes the synthetic Host execute business work. */
export async function lockNativeOnceAdmissions(
  tx: Tx,
  controls: readonly NativeOnceControl[],
) {
  const result = new Map<string, NativeOnceLockedAdmission>();
  for (const c of [...controls].sort((a, b) =>
    `${a.organizationId}:${a.ownerId}:${a.automationId}`.localeCompare(
      `${b.organizationId}:${b.ownerId}:${b.automationId}`,
    ),
  )) {
    const scope = {
      organizationId: c.organizationId,
      workspaceId: c.workspaceId,
      ownerId: c.ownerId,
    };
    const principal = await readContentPrincipal(
      identity(scope),
      tx,
      'update_user',
    );
    const settings = await readWorkAutomation(tx, {
      ...scope,
      userId: scope.ownerId,
    });
    // Authority denial may still persist a blocked native receipt or delete.
    // Read only scoped metadata until every current content gate is satisfied.
    const [meta] = await tx<
      Pick<
        Plan,
        | 'id'
        | 'organization_id'
        | 'workspace_id'
        | 'owner_id'
        | 'revision'
        | 'status'
        | 'clock_owner'
        | 'deleted_at'
        | 'native_once_cancelled_at'
      >[]
    >`
      select id,organization_id,workspace_id,owner_id,revision,status,clock_owner,deleted_at,native_once_cancelled_at
      from allrice_automations where id=${c.automationId} and organization_id=${scope.organizationId}
        and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} for update`;
    if (!meta) continue;
    const [target] = await tx<Target[]>`
      select s.id,s.organization_id,s.workspace_id,s.owner_id,s.employee_assignment_id,
        coalesce(s.employee_instance_id,s.employee_assignment_id) employee_instance_id
      from allrice_chat_sessions s
      join allrice_employee_assignments a on a.id=s.employee_assignment_id and a.organization_id=s.organization_id and a.workspace_id=s.workspace_id and a.user_id=s.owner_id and a.active
      join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id and e.status='active' and e.employee_key not like 'platform-%'
      join allrice_employee_instances i on i.id=coalesce(s.employee_instance_id,s.employee_assignment_id) and i.assignment_id=a.id and i.owner_id=s.owner_id and i.archived_at is null
      where s.id=${c.dispatch.businessSessionId} and s.organization_id=${c.organizationId} and s.workspace_id=${c.workspaceId}
        and s.owner_id=${c.ownerId} and s.archived_at is null for share of a,e,i,s`;
    const permitted =
      !!principal?.writable &&
      settings.available &&
      settings.settings.cloud &&
      !!target;
    let digest: string | null = null;
    if (
      permitted &&
      target.employee_assignment_id === c.dispatch.employeeAssignmentId &&
      target.employee_instance_id === c.dispatch.employeeInstanceId
    ) {
      await assertWorkbenchSession(
        tx,
        identity(scope),
        target.id,
        true,
        'share',
      );
      const [plan] = await tx<
        Plan[]
      >`select * from allrice_automations where id=${meta.id}`;
      digest = reservation(plan!, c);
    }
    result.set(c.controlId, {
      organizationId: meta.organization_id,
      workspaceId: meta.workspace_id,
      ownerId: meta.owner_id,
      automationId: meta.id,
      currentRevision: meta.revision,
      employeeAssignmentId: target?.employee_assignment_id ?? null,
      employeeInstanceId: target?.employee_instance_id ?? null,
      businessSessionId: target?.id ?? null,
      reservationDigest: digest,
      planStatus:
        meta.deleted_at || meta.native_once_cancelled_at
          ? 'deleted'
          : meta.status,
      currentWritableIdentity: !!principal?.writable,
      cloudEnabled: settings.available && settings.settings.cloud,
      assignmentActive: !!target,
      instanceActive: !!target,
      businessSessionAvailable: !!target,
      legacyClockExcluded: meta.clock_owner === 'native_once',
    });
  }
  return result;
}

async function browserScope(
  tx: Tx,
  context: RequestContext,
  sessionId: string,
) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  const [row] = await tx<{ workspace_id: string }[]>`
    select workspace_id from allrice_chat_sessions where id=${UuidSchema.parse(sessionId)}
      and organization_id=${context.organizationId} and owner_id=${context.actor.id}
      and (${context.workspaceId}::uuid is null or workspace_id=${context.workspaceId}) and archived_at is null`;
  if (!row) throw new DataAccessError('not_found');
  return {
    organizationId: context.organizationId,
    workspaceId: row.workspace_id,
    ownerId: context.actor.id,
  };
}

async function readTask(tx: Tx, p: Plan): Promise<OnceTask> {
  const [state] = await tx<
    {
      command_status: string | null;
      task: unknown;
      outbox_state: string | null;
      outbox_reason: string | null;
      run_id: string | null;
      run_state: string | null;
      job_status: string | null;
      error_message: string | null;
    }[]
  >`
    select c.snapshot->'control'->'command'->>'status' command_status,c.snapshot->'task' task,
      o.outbox_state,o.outbox_reason,r.id run_id,r.state run_state,j.status job_status,j.last_error_message error_message
    from allrice_native_once_controls c
    left join allrice_native_once_occurrences o on o.partition_id=c.partition_id and o.control_id=c.control_id
    left join allrice_automation_runs ar on ar.native_once_occurrence_id=o.occurrence_id and ar.automation_id=c.automation_id
    left join allrice_runs r on r.id=ar.run_id and r.organization_id=${p.organization_id} and r.workspace_id=${p.workspace_id} and r.owner_id=${p.owner_id}
    left join allrice_jobs j on j.run_id=r.id
    where c.automation_id=${p.id} and c.revision=${p.revision}`;
  let status: OnceTask['status'] = 'preparing';
  if (state?.run_id) {
    const value = state.run_state;
    status =
      value === 'succeeded'
        ? 'succeeded'
        : value === 'failed'
          ? 'failed'
          : value === 'canceled'
            ? 'canceled'
            : value === 'waiting_approval' || value === 'waiting_input'
              ? 'awaiting_input'
              : value === 'running'
                ? 'running'
                : 'queued';
  } else if (p.native_once_cancelled_at) status = 'canceled';
  else if (
    state?.outbox_state === 'blocked' ||
    state?.command_status === 'blocked'
  )
    status = 'not_executed';
  else if (state?.task || state?.command_status === 'confirmed')
    status = 'pending';
  return OnceTaskSchema.parse({
    id: p.id,
    clientRequestId: p.native_once_request_id,
    name: p.name,
    prompt: p.prompt,
    sessionId: p.session_id,
    runAt: p.schedule.runAt,
    timezone: p.schedule.timezone,
    status,
    runId: state?.run_id ?? null,
    errorMessage:
      status === 'not_executed'
        ? '任务未执行，时间或当前使用权限已变化。请在聊天中重新安排。'
        : (state?.error_message ?? null),
    createdAt: p.created_at.toISOString(),
    canCancel:
      !state?.run_id &&
      !p.native_once_cancelled_at &&
      status !== 'not_executed',
  });
}

/** Only this enrollment writes a native clock owner. Stable request keys and
 * immutable inputs resolve an unknown POST outcome without making a new task. */
async function enroll(
  tx: Tx,
  scope: Scope,
  target: Target,
  input: CreateOnceTaskInput,
  logicalDigest?: string,
) {
  const requestDigest =
    logicalDigest ?? runtimePolicyDigest({ ...input, sessionId: target.id });
  const [old] = await tx<
    Plan[]
  >`select * from allrice_automations where organization_id=${scope.organizationId}
    and owner_id=${scope.ownerId} and native_once_request_id=${input.clientRequestId} and clock_owner='native_once' for update`;
  if (old) {
    if (
      old.native_once_request_digest !== requestDigest ||
      old.session_id !== target.id
    )
      throw new NativeOnceProductError('request_conflict');
    return readTask(tx, old);
  }
  const [now] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  const runAt = new Date(input.runAt).toISOString();
  if (
    Date.parse(runAt) <= now!.now.getTime() + 5_000 ||
    Date.parse(runAt) > now!.now.getTime() + 366 * 86_400_000
  )
    throw new NativeOnceProductError('time_invalid');
  const [partition] = await tx<
    {
      partition_id: string;
      reference: NativeOnceReference;
      activation: NativeOnceReadiness;
    }[]
  >`
    select partition_id,reference,activation from allrice_native_once_partitions where partition_id='allrice-once-v1' for share`;
  if (
    !nativeOnceProductEnabled() ||
    !partition ||
    !nativeOnceReady(partition.activation)
  )
    throw new NativeOnceProductError('disabled');
  const [p] = await tx<Plan[]>`insert into allrice_automations
    (organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,next_run_at,
      clock_owner,native_once_request_id,native_once_request_digest)
    values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${input.name},${input.prompt},'schedule',
      ${json(tx, { frequency: 'once', runAt, timezone: input.timezone })},'enabled','reuse',${target.employee_assignment_id},${target.id},${runAt},
      'native_once',${input.clientRequestId},${requestDigest}) returning *`;
  const control: NativeOnceControl = {
    partitionId: partition.partition_id,
    controlId: randomUUID(),
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    ownerId: scope.ownerId,
    automationId: p!.id,
    revision: 1,
    controlSessionId: `once-${randomUUID()}`,
    at: runAt,
    sessionState: 'reserved',
    nativeTaskId: null,
    taskDeleted: false,
    command: { id: randomUUID(), kind: 'create', status: 'pending' },
    dispatch: {
      occurrenceId: randomUUID(),
      employeeAssignmentId: target.employee_assignment_id,
      employeeInstanceId: target.employee_instance_id,
      businessSessionId: target.id,
      clientMessageId: randomUUID(),
      reservationDigest: '',
    },
  };
  control.dispatch.reservationDigest = reservation(p!, control);
  await tx`insert into allrice_native_once_controls
    (partition_id,control_id,automation_id,revision,control_session_id,occurrence_id,client_message_id,immutable_control,snapshot)
    values(${control.partitionId},${control.controlId},${p!.id},1,${control.controlSessionId},${control.dispatch.occurrenceId},
      ${control.dispatch.clientMessageId},${json(tx, control)},${json(tx, { control, task: null })})`;
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason)
    values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},'automation.create','automation',${p!.id},'allowed','native_once_enrollment')`;
  return readTask(tx, p!);
}

export async function createOnceTask(
  contextInput: RequestContext,
  sessionId: string,
  raw: unknown,
) {
  const context = RequestContextSchema.parse(contextInput),
    input = CreateOnceTaskInputSchema.parse(raw);
  return getDatabase().begin(async (tx) => {
    await acquireDevAdmission(tx);
    const scope = await browserScope(tx, context, sessionId);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`native-once-request:${scope.organizationId}:${scope.ownerId}:${input.clientRequestId}`},0))`;
    await lockPrincipal(tx, scope, input.clientRequestId, {
      ...context,
      workspaceId: scope.workspaceId,
    });
    const settings = await readWorkAutomation(tx, {
      ...scope,
      userId: scope.ownerId,
    });
    if (!settings.available || !settings.settings.cloud)
      throw new DataAccessError('authorization_denied');
    const target = await targetMetadata(tx, scope, sessionId);
    await lockTarget(tx, scope, target);
    return enroll(tx, scope, target, input);
  });
}

const OnceTaskCursorSchema = z
  .object({ createdAt: TimestampSchema, id: UuidSchema })
  .strict();

export async function listOnceTasks(
  contextInput: RequestContext,
  sessionId: string,
  queryInput: { clientRequestId?: string; cursor?: string } = {},
) {
  const context = RequestContextSchema.parse(contextInput);
  const query = OnceTaskListQuerySchema.parse(queryInput);
  let rawCursor: unknown = null;
  if (query.cursor) {
    try {
      rawCursor = JSON.parse(
        Buffer.from(query.cursor, 'base64url').toString('utf8'),
      );
    } catch {
      rawCursor = null;
    }
  }
  const cursor = query.cursor ? OnceTaskCursorSchema.parse(rawCursor) : null;
  return getDatabase().begin(async (tx) => {
    const scope = await browserScope(tx, context, sessionId);
    const principal = await readContentPrincipal(
      { ...context, workspaceId: scope.workspaceId },
      tx,
    );
    if (!principal) throw new DataAccessError('authorization_denied');
    const target = await targetMetadata(tx, scope, sessionId);
    // Read only, including canceled history. No demo seeding or implicit work.
    const plans = await tx<Plan[]>`select a.* from allrice_automations a
      join allrice_native_once_controls c on c.automation_id=a.id and c.revision=a.revision
      where a.organization_id=${scope.organizationId} and a.workspace_id=${scope.workspaceId} and a.owner_id=${scope.ownerId}
        and a.employee_assignment_id=${target.employee_assignment_id} and a.clock_owner='native_once'
        and c.immutable_control->'dispatch'->>'employeeInstanceId'=${target.employee_instance_id}
        and (${query.clientRequestId ?? null}::uuid is null or a.native_once_request_id=${query.clientRequestId ?? null}::uuid)
        and (${cursor?.createdAt ?? null}::timestamptz is null or (a.created_at,a.id)<(${cursor?.createdAt ?? null}::timestamptz,${cursor?.id ?? null}::uuid))
      order by a.created_at desc,a.id desc limit 51`;
    const [partition] = await tx<
      { activation: NativeOnceReadiness }[]
    >`select activation from allrice_native_once_partitions where partition_id='allrice-once-v1'`;
    const settings = await readWorkAutomation(tx, {
      ...scope,
      userId: scope.ownerId,
    });
    const [ordinary] = await tx`select a.id from allrice_employee_assignments a
      join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
      join allrice_employee_instances i on i.assignment_id=a.id and i.id=${target.employee_instance_id} and i.owner_id=a.user_id and i.archived_at is null
      where a.id=${target.employee_assignment_id} and a.organization_id=${scope.organizationId} and a.workspace_id=${scope.workspaceId}
        and a.user_id=${scope.ownerId} and a.active and e.status='active' and e.employee_key not like 'platform-%'`;
    const page = plans.slice(0, 50),
      last = page.at(-1);
    return {
      tasks: await Promise.all(
        page.map(async (p) => {
          const task = await readTask(tx, p);
          return { ...task, canCancel: task.canCancel && principal.writable };
        }),
      ),
      enabled:
        nativeOnceProductEnabled() &&
        !!partition &&
        nativeOnceReady(partition.activation) &&
        principal.writable &&
        settings.available &&
        settings.settings.cloud &&
        !!ordinary,
      nextCursor:
        plans.length > 50 && last
          ? Buffer.from(
              JSON.stringify({
                createdAt: last.created_at.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  });
}

export async function cancelOnceTask(
  contextInput: RequestContext,
  sessionId: string,
  taskId: string,
) {
  const context = RequestContextSchema.parse(contextInput);
  UuidSchema.parse(taskId);
  return getDatabase().begin(async (tx) => {
    const scope = await browserScope(tx, context, sessionId);
    // Metadata only, then the same principal/settings/plan order as dispatch.
    // The plan row serializes pending cancellation with the atomic handoff.
    const [projection] = await tx<
      ControlRow[]
    >`select partition_id,control_id,snapshot from allrice_native_once_controls where automation_id=${taskId}`;
    if (!projection) throw new DataAccessError('not_found');
    await lockPrincipal(tx, scope, context.requestId, {
      ...context,
      workspaceId: scope.workspaceId,
    });
    await readWorkAutomation(tx, { ...scope, userId: scope.ownerId });
    const target = await targetMetadata(tx, scope, sessionId);
    const [p] = await tx<
      Plan[]
    >`select * from allrice_automations where id=${taskId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and clock_owner='native_once' for update`;
    if (
      !p ||
      p.employee_assignment_id !== target.employee_assignment_id ||
      projection.snapshot.control.dispatch.employeeInstanceId !==
        target.employee_instance_id
    )
      throw new DataAccessError('not_found');
    const task = await readTask(tx, p);
    if (task.runId || !task.canCancel) return task;
    const [control] = await tx<
      ControlRow[]
    >`select partition_id,control_id,snapshot from allrice_native_once_controls
      where partition_id=${projection.partition_id} and control_id=${projection.control_id} for update`;
    if (
      !control ||
      !isDeepStrictEqual(
        control.snapshot.control.dispatch,
        projection.snapshot.control.dispatch,
      )
    )
      throw new NativeOnceProductError('binding_conflict');
    const snapshot = structuredClone(control.snapshot);
    snapshot.control.command = {
      id: randomUUID(),
      kind: 'delete',
      status: 'pending',
    };
    await tx`update allrice_automations set native_once_cancelled_at=clock_timestamp(),status='paused',next_run_at=null,updated_at=clock_timestamp() where id=${p.id}`;
    await tx`update allrice_native_once_controls set snapshot=${json(tx, snapshot)},snapshot_version=snapshot_version+1
      where partition_id=${control.partition_id} and control_id=${control.control_id}`;
    await tx`update allrice_native_once_occurrences set outbox_state='blocked',outbox_reason='user_canceled'
      where occurrence_id=${snapshot.control.dispatch.occurrenceId} and outbox_state='pending'`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason)
      values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},'automation.cancel','automation',${p.id},'allowed','native_once_pending_canceled')`;
    const [updated] = await tx<
      Plan[]
    >`select * from allrice_automations where id=${p.id}`;
    return readTask(tx, updated!);
  });
}

/** Deployment-approved public control profile. Existing partition identity and
 * close proofs are never replaced by startup or by lease expiry. */
export async function initializeNativeOncePartition(
  reference: NativeOnceReference,
) {
  if (!nativeOnceProductEnabled()) throw new NativeOnceProductError('disabled');
  let approved: unknown;
  try {
    approved = JSON.parse(process.env.ALLRICE_NATIVE_ONCE_REFERENCE ?? 'null');
  } catch {
    throw new NativeOnceProductError('disabled');
  }
  if (
    !isDeepStrictEqual(approved, reference) ||
    Object.keys(reference).length !== 4 ||
    !/^sha256:[a-f0-9]{64}$/.test(reference.artifactId) ||
    reference.profileId !== 'allrice-once-control-v1' ||
    !reference.storageId ||
    !isAbsolute(reference.stateRoot) ||
    (await realpath(reference.stateRoot)) !== reference.stateRoot ||
    !(await stat(reference.stateRoot)).isDirectory()
  )
    throw new NativeOnceProductError('binding_conflict');
  await access(reference.stateRoot, constants.R_OK | constants.W_OK);
  return getDatabase().begin(async (tx) => {
    // The migration installs exclusion columns/constraints and all consumers in
    // this release explicitly filter legacy. Do not activate a partial schema.
    const [schema] =
      await tx`select to_regclass(format('%I.allrice_native_once_occurrences',current_schema())) is not null as ready,
      exists(select 1 from information_schema.columns where table_schema=current_schema() and table_name='allrice_automations' and column_name='clock_owner') as exclusion`;
    if (!schema?.ready || !schema.exclusion)
      throw new NativeOnceProductError('disabled');
    const activation = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
    await tx`insert into allrice_native_once_partitions(partition_id,reference,activation)
      values('allrice-once-v1',${json(tx, reference)},${json(tx, activation)}) on conflict(partition_id) do nothing`;
    const [row] = await tx<
      {
        partition_id: string;
        reference: NativeOnceReference;
        activation: typeof activation;
      }[]
    >`
      select partition_id,reference,activation from allrice_native_once_partitions where partition_id='allrice-once-v1' for share`;
    if (
      !row ||
      !isDeepStrictEqual(row.reference, reference) ||
      !nativeOnceReady(row.activation)
    )
      throw new NativeOnceProductError('binding_conflict');
    return {
      partitionId: row.partition_id,
      reference: row.reference,
      activation: row.activation,
    };
  });
}

export async function createOnceTaskFromExecutionContext(
  input: EmployeeChatCall & {
    name: string;
    prompt: string;
    delayMinutes: number;
  },
) {
  const { ctx, scope } = employeeChatIdentity(input);
  if (
    !Number.isSafeInteger(input.delayMinutes) ||
    input.delayMinutes < 1 ||
    input.delayMinutes > 525600 ||
    !ctx.policySnapshot.grants.some(
      (g) =>
        g.resourceType === 'automation' &&
        g.action === 'resource:write' &&
        (g.workspaceId === null || g.workspaceId === scope.workspaceId),
    )
  )
    throw new DataAccessError('authorization_denied');
  const requestId = employeeChatUuid(
    'native-once-call',
    ctx.organizationId,
    ctx.workspaceId!,
    ctx.runId,
    input.callId,
  );
  // Relative time is evaluated once, after the stable call has been checked.
  const logicalDigest = runtimePolicyDigest({
    kind: 'native-once-call',
    runId: ctx.runId,
    callId: input.callId,
    sessionId: input.sessionId,
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    delayMinutes: input.delayMinutes,
  });
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    await tx`set local lock_timeout='1000ms'`;
    await tx`set local statement_timeout='10000ms'`;
    await acquireDevAdmission(tx);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`native-once-request:${scope.organizationId}:${scope.actor.id}:${requestId}`},0))`;
    const ownerScope = {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      ownerId: scope.actor.id,
    };
    await lockPrincipal(tx, ownerScope, requestId);
    const work = await readWorkAutomation(tx, {
      ...ownerScope,
      userId: ownerScope.ownerId,
    });
    if (!work.available || !work.settings.cloud)
      throw new DataAccessError('authorization_denied');
    const target = await targetMetadata(tx, ownerScope, input.sessionId);
    const instance = await lockTarget(tx, ownerScope, target);
    const current = await assertEmployeeChatExecution(
      tx,
      input,
      instance,
      'automation.create',
    );
    // A scheduled/internal producer also persists role=user. Its occurrence
    // exists before the message, even if the legacy dispatcher has not yet
    // linked run_id. Never let that text authorize another background task.
    const [source] = await tx<{ internal: boolean }[]>`
      select exists(select 1 from allrice_automation_runs a
          where a.run_id=${ctx.runId} or a.id=m.client_message_id)
        or exists(select 1 from allrice_automation_folder_events e
          where e.run_id=${ctx.runId} or e.id=m.client_message_id)
        or exists(select 1 from allrice_workflow_runs w where w.run_id=${ctx.runId})
        or exists(select 1 from allrice_platform_quality_checks q where q.run_id=${ctx.runId})
        or exists(select 1 from allrice_platform_repair_tasks r where r.run_id=${ctx.runId})
        or exists(select 1 from allrice_platform_repository_review_subjects s where s.run_id=${ctx.runId})
        as internal from allrice_messages m where m.id=${input.userMessageId}`;
    if (!source || source.internal || current.snapshot.workflowInvocation)
      throw new DataAccessError('authorization_denied');
    const [old] = await tx<
      Plan[]
    >`select * from allrice_automations where organization_id=${scope.organizationId}
      and owner_id=${scope.actor.id} and native_once_request_id=${requestId} and clock_owner='native_once' for update`;
    if (old) {
      if (
        old.native_once_request_digest !== logicalDigest ||
        old.session_id !== input.sessionId
      )
        throw new NativeOnceProductError('request_conflict');
      return readTask(tx, old);
    }
    const intent = explicitOnceTaskIntent(current.text);
    if (!intent) throw new NativeOnceProductError('intent_required');
    if (intent.delayMinutes !== input.delayMinutes)
      throw new NativeOnceProductError('time_mismatch');
    const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
    return enroll(
      tx,
      ownerScope,
      target,
      CreateOnceTaskInputSchema.parse({
        clientRequestId: requestId,
        name: input.name,
        // The model supplies a title and call arguments, not a replacement for
        // the user's authorized work. Preserve the original request verbatim.
        prompt: intent.authoritativeRequest,
        runAt: new Date(
          clock!.now.getTime() + input.delayMinutes * 60_000,
        ).toISOString(),
        timezone: 'Asia/Shanghai',
      }),
      logicalDigest,
    );
  });
}

type OccurrenceRow = {
  occurrence_id: string;
  partition_id: string;
  control_id: string;
  automation_id: string;
  revision: number;
  payload_digest: string;
  payload: {
    control: NativeOnceControl;
    nativeTaskId: string;
    receipt: { scheduledAt: string };
  };
  outbox_state: 'pending' | 'blocked' | 'enqueued';
  outbox_reason: string | null;
  outbox_owner_id: string | null;
  outbox_epoch: number;
  outbox_token_digest: string | null;
  outbox_expires_at: Date | null;
  business_binding: unknown;
};
type DispatchReservation = {
  occurrence: OccurrenceRow;
  control: NativeOnceControl;
  plan: Plan;
  principal: ResourcePrincipal;
};
const dispatchReservations = new WeakMap<Tx, DispatchReservation>();

/** This evidence only exists while the dispatcher owns current product locks
 * in this exact transaction. An exported function or copied JSON is no grant. */
export function nativeOnceMessageReservation(
  tx: Tx,
  context: ResourcePrincipal,
  occurrenceId: string,
) {
  const r = dispatchReservations.get(tx);
  if (
    !r ||
    r.occurrence.occurrence_id !== occurrenceId ||
    !isDeepStrictEqual(r.principal, context)
  )
    throw new NativeOnceProductError('binding_conflict');
  const duePrompt = [
    '这项一次性任务已经到期，请现在执行下面原始要求中的工作。',
    '原文中的相对时间和“不要现在执行”指预约创建时刻；本轮无需再次等待、创建或修改预约。',
    `原始要求：\n${r.plan.prompt}`,
  ].join('\n');
  return {
    workspaceId: r.plan.workspace_id,
    sessionId: r.control.dispatch.businessSessionId,
    clientMessageId: r.control.dispatch.clientMessageId,
    // New chat requests are bounded to 32k. Existing/form tasks may use the
    // entire 40k message limit: retain their original behavior and every byte.
    prompt: duePrompt.length <= 40_000 ? duePrompt : r.plan.prompt,
  };
}
export async function assertNativeOnceQueueBinding(
  tx: Tx,
  context: ResourcePrincipal,
  occurrenceId: string,
  binding: {
    sessionId: string;
    employeeAssignmentId: string;
    userMessageId: string;
    promptSnapshot: Record<string, unknown>;
    executionSnapshot: { instance?: { id: string } };
  },
  clientMessageId: string,
) {
  const input = nativeOnceMessageReservation(tx, context, occurrenceId),
    r = dispatchReservations.get(tx)!;
  if (
    binding.sessionId !== input.sessionId ||
    binding.employeeAssignmentId !== r.control.dispatch.employeeAssignmentId ||
    binding.executionSnapshot.instance?.id !==
      r.control.dispatch.employeeInstanceId ||
    clientMessageId !== input.clientMessageId ||
    binding.promptSnapshot.userRequest !== input.prompt
  )
    throw new NativeOnceProductError('binding_conflict');
  const rows =
    await tx`select id from allrice_messages where id=${binding.userMessageId} and session_id=${input.sessionId}
    and organization_id=${context.organizationId} and workspace_id=${input.workspaceId} and owner_id=${context.actor.id}
    and role='user' and client_message_id=${clientMessageId} and content->>'text'=${input.prompt}`;
  if (rows.length !== 1) throw new NativeOnceProductError('binding_conflict');
}

/** Native Schedule is the only clock. This consumer only claims durable native
 * receipts; its short lease is independent of Host and business Job ownership. */
export async function dispatchNextNativeOnceOccurrence(workerId: string) {
  UuidSchema.parse(workerId);
  if (!nativeOnceProductEnabled()) return false;
  const token = randomUUID(),
    tokenDigest = nativeOnceDigest(token),
    db = getDatabase();
  const occurrence = await db.begin(async (tx) => {
    await acquireDevAdmission(tx);
    const [row] = await tx<
      OccurrenceRow[]
    >`select * from allrice_native_once_occurrences
      where outbox_state='pending' and (outbox_owner_id is null or outbox_expires_at<=clock_timestamp())
      order by created_at,occurrence_id limit 1 for update skip locked`;
    if (!row) return null;
    const [claimed] = await tx<
      OccurrenceRow[]
    >`update allrice_native_once_occurrences
      set outbox_owner_id=${workerId},outbox_epoch=outbox_epoch+1,outbox_token_digest=${tokenDigest},outbox_expires_at=clock_timestamp()+interval '30 seconds'
      where occurrence_id=${row.occurrence_id} returning *`;
    return claimed!;
  });
  if (!occurrence) return false;
  // A failed/unknown COMMIT leaves the durable occurrence for exact readback.
  // No new key, receipt or message is created by error handling.
  await db.begin(async (tx) => {
    await tx`set local lock_timeout='1000ms'`;
    await tx`set local statement_timeout='10000ms'`;
    await acquireDevAdmission(tx);
    const [projection] = await tx<
      ControlRow[]
    >`select partition_id,control_id,snapshot from allrice_native_once_controls
      where partition_id=${occurrence.partition_id} and control_id=${occurrence.control_id}`;
    if (!projection) throw new NativeOnceProductError('binding_conflict');
    const control = projection.snapshot.control,
      scope = {
        organizationId: control.organizationId,
        workspaceId: control.workspaceId,
        ownerId: control.ownerId,
      };
    const facts = (await lockNativeOnceAdmissions(tx, [control])).get(
      control.controlId,
    );
    const permitted =
      !!facts &&
      facts.currentWritableIdentity &&
      facts.cloudEnabled &&
      facts.assignmentActive &&
      facts.instanceActive &&
      facts.businessSessionAvailable &&
      facts.legacyClockExcluded &&
      facts.planStatus === 'enabled' &&
      facts.currentRevision === control.revision &&
      facts.reservationDigest === control.dispatch.reservationDigest &&
      facts.employeeAssignmentId === control.dispatch.employeeAssignmentId &&
      facts.employeeInstanceId === control.dispatch.employeeInstanceId &&
      facts.businessSessionId === control.dispatch.businessSessionId;
    const lockReceipt = async (allowCanceled = false) => {
      const [live] = await tx<
        OccurrenceRow[]
      >`select * from allrice_native_once_occurrences where occurrence_id=${occurrence.occurrence_id} for update`;
      if (
        !live ||
        live.outbox_owner_id !== workerId ||
        live.outbox_epoch !== occurrence.outbox_epoch ||
        live.outbox_token_digest !== tokenDigest ||
        live.payload_digest !== occurrence.payload_digest ||
        !isDeepStrictEqual(live.payload, occurrence.payload)
      )
        throw new NativeOnceProductError('lease_lost');
      // Cancellation holds the same plan lock and can legitimately win after
      // our short claim. Preserve its terminal receipt; no business work ran.
      if (
        allowCanceled &&
        live.outbox_state === 'blocked' &&
        live.outbox_reason === 'user_canceled'
      )
        return null;
      if (live.outbox_state !== 'pending')
        throw new NativeOnceProductError('lease_lost');
      const [lease] =
        await tx`select 1 from allrice_native_once_occurrences where occurrence_id=${live.occurrence_id} and outbox_expires_at>clock_timestamp()`;
      if (!lease) throw new NativeOnceProductError('lease_lost');
      return live;
    };
    if (!permitted) {
      if (!(await lockReceipt(true))) return;
      await tx`update allrice_native_once_occurrences set outbox_state='blocked',outbox_reason='current_authority_or_binding_changed' where occurrence_id=${occurrence.occurrence_id}`;
      return;
    }
    const principal = await lockPrincipal(tx, scope, occurrence.occurrence_id);
    const target = await targetMetadata(
      tx,
      scope,
      control.dispatch.businessSessionId,
    );
    await lockTarget(tx, scope, target);
    const [plan] = await tx<
      Plan[]
    >`select * from allrice_automations where id=${control.automationId}`;
    if (
      !plan ||
      reservation(plan, control) !== control.dispatch.reservationDigest ||
      occurrence.payload_digest !== nativeOnceDigest(occurrence.payload)
    )
      throw new NativeOnceProductError('binding_conflict');
    const [mapped] = await tx`select 1 from allrice_native_once_occurrences o
      join allrice_native_once_controls c on c.partition_id=o.partition_id and c.control_id=o.control_id
      where o.occurrence_id=${occurrence.occurrence_id} and o.automation_id=${plan.id} and o.revision=${plan.revision}
        and c.native_task_id=o.payload->>'nativeTaskId' and c.immutable_control->'dispatch'=o.payload->'control'->'dispatch'`;
    if (!mapped) throw new NativeOnceProductError('binding_conflict');
    dispatchReservations.set(tx, { occurrence, control, plan, principal });
    try {
      const { prepareNativeOnceChatRunInTransaction } =
        await import('./workspace/service.ts');
      const queued = await prepareNativeOnceChatRunInTransaction(
        tx,
        principal,
        occurrence.occurrence_id,
      );
      await lockReceipt();
      const [frozen] = await tx<
        { execution_snapshot: unknown }[]
      >`select execution_snapshot from allrice_employee_runs where run_id=${queued.runId}`;
      if (!frozen) throw new NativeOnceProductError('binding_conflict');
      const business = {
        ...queued,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        ownerId: scope.ownerId,
        sessionId: target.id,
        employeeAssignmentId: target.employee_assignment_id,
        employeeInstanceId: target.employee_instance_id,
        clientMessageId: control.dispatch.clientMessageId,
        payloadDigest: occurrence.payload_digest,
        snapshotDigest: runtimePolicyDigest(frozen.execution_snapshot),
      };
      await tx`insert into allrice_automation_runs(organization_id,workspace_id,automation_id,scheduled_for,run_id,session_id,status,native_once_occurrence_id)
        values(${scope.organizationId},${scope.workspaceId},${plan.id},${occurrence.payload.receipt.scheduledAt}::timestamptz,${queued.runId},${target.id},'queued',${occurrence.occurrence_id})`;
      await tx`update allrice_native_once_occurrences set outbox_state='enqueued',business_binding=${json(tx, business)} where occurrence_id=${occurrence.occurrence_id}`;
      await tx`update allrice_automations set next_run_at=null,status='paused',updated_at=clock_timestamp() where id=${plan.id}`;
    } finally {
      dispatchReservations.delete(tx);
    }
  });
  return true;
}
