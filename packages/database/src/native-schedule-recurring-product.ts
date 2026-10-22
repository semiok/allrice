import { randomUUID } from 'node:crypto';
import { NativeCalendarControlSchema } from './native-schedule-calendar-state.ts';
import { dispatchExperienceCalendarNative } from './experience-native.ts';
import { isDeepStrictEqual } from 'node:util';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import {
  CreateRecurringTaskInputSchema,
  ChangeRecurringTaskInputSchema,
  RecurringTaskSchema,
  RecurringOccurrenceSchema,
  RecurringTaskOperationSchema,
  RecurringTaskListQuerySchema,
  RecurringTaskDetailQuerySchema,
  RequestContextSchema,
  TimestampSchema,
  UuidSchema,
  type RequestContext,
  type RecurringTask,
  type RecurringOccurrence,
  type CreateRecurringTaskInput,
  type ChangeRecurringTaskInput,
  type RecurringScheduleRule,
  RecurringScheduleRuleSchema,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { acquireDevAdmission } from './dev-maintenance.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { readWorkAutomation } from './work-automation.ts';
import { assertWorkbenchSession } from './artifact-review.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import type { ResourcePrincipal } from './resource-principal.ts';
import {
  scheduleIdentity,
  lockSchedulePrincipal,
  readScheduleTarget,
  lockScheduleTarget,
  readScheduleBrowserScope,
  type ScheduleScope,
  type ScheduleTarget,
} from './native-schedule-authority.ts';
import { employeeAccessTransaction } from './employees/employee-access-cancellation.ts';
import { explicitRecurringTaskIntent } from './employees/recurring-task-intent.ts';
import { readScheduleClarification } from './employees/schedule-clarification-authority.ts';
import {
  assertEmployeeChatExecution,
  assertEmployeeChatHumanSource,
  employeeChatIdentity,
  employeeChatUuid,
  type EmployeeChatCall,
} from './employees/employee-chat-authority.ts';
import {
  nativeOnceDigest,
  nativeOnceReady,
  type NativeOnceReference,
  type NativeOnceReadiness,
} from './native-schedule-once-state.ts';
import {
  NativeRecurringControlSchema,
  NativeRecurringRevisionSchema,
  recurringControlIdentity,
  type NativeRecurringControl,
  type NativeRecurringRevision,
  type NativeRecurringSnapshot,
  type NativeRecurringAdmission,
  type NativeRecurringOccurrence,
} from './native-schedule-recurring-state.ts';
import {
  lockPlatformQualityNativeAdmission,
  dispatchPlatformQualityNative,
  migrateOneLegacyQualitySchedule,
} from './platform-quality-native.ts';

type Tx = TransactionSql;
export type RecurringPlan = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  employee_assignment_id: string;
  session_id: string;
  name: string;
  prompt: string;
  status: 'enabled' | 'paused';
  clock_owner: string;
  revision: number;
  native_recurring_revision: number;
  native_recurring_request_id: string;
  native_recurring_request_digest: string;
  native_recurring_resume_after: Date | null;
  schedule: {
    frequency: 'native_recurring';
    rule: CreateRecurringTaskInput['rule'];
  };
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
type Plan = RecurringPlan;
type ControlRow = {
  partition_id: string;
  control_id: string;
  snapshot: NativeRecurringSnapshot;
};
type OperationRow = {
  operation_id: string;
  automation_id: string;
  request: ChangeRecurringTaskInput;
  request_digest: string;
  status: 'pending' | 'applied' | 'rejected';
  error_message: string | null;
};
export const nativeRecurringProductEnabled = () =>
  process.env.ALLRICE_NATIVE_RECURRING_ENABLED === '1';
export class NativeRecurringProductError extends Error {
  constructor(
    readonly code:
      | 'disabled'
      | 'request_conflict'
      | 'binding_conflict'
      | 'lease_lost'
      | 'limit'
      | 'intent_required'
      | 'rule_mismatch',
  ) {
    super(`native_recurring_${code}`);
  }
}
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
const scopeOf = (p: Plan | NativeRecurringControl): ScheduleScope =>
  'organization_id' in p
    ? {
        organizationId: p.organization_id,
        workspaceId: p.workspace_id,
        ownerId: p.owner_id,
      }
    : {
        organizationId: p.organizationId,
        workspaceId: p.workspaceId,
        ownerId: p.ownerId,
      };
const CursorSchema = z.object({ at: TimestampSchema, id: UuidSchema }).strict();
function cursor(raw: string | undefined) {
  if (!raw) return null;
  try {
    return CursorSchema.parse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
  } catch {
    throw new SyntaxError('Invalid task cursor');
  }
}
// Preserve PostgreSQL microseconds: a JS Date would skip rows sharing the
// final millisecond of a page when compared with the original SQL timestamp.
const encodeCursor = (at: string, id: string) =>
  Buffer.from(JSON.stringify({ at, id })).toString('base64url');
function reservation(
  p: Plan,
  c: NativeRecurringControl,
  v: Omit<NativeRecurringRevision, 'reservationDigest'>,
) {
  if ('consumer' in c.dispatch || 'consumer' in v)
    throw new NativeRecurringProductError('binding_conflict');
  return runtimePolicyDigest({
    ...scopeOf(p),
    automationId: p.id,
    assignmentId: p.employee_assignment_id,
    instanceId: c.dispatch.employeeInstanceId,
    sessionId: p.session_id,
    ...v,
  });
}
async function currentRead(
  tx: Tx,
  context: RequestContext,
  sessionId: string,
  includeArchived = false,
) {
  const scope = await readScheduleBrowserScope(
    tx,
    context,
    sessionId,
    includeArchived,
  );
  const principal = await readContentPrincipal(
    { ...context, workspaceId: scope.workspaceId },
    tx,
  );
  if (!principal) throw new DataAccessError('authorization_denied');
  await assertWorkbenchSession(tx, scheduleIdentity(scope), sessionId, false);
  const settings = await readWorkAutomation(tx, {
    ...scope,
    userId: scope.ownerId,
  });
  const [partition] = await tx<
    { activation: NativeOnceReadiness }[]
  >`select activation from allrice_native_once_partitions where partition_id='allrice-recurring-v1'`;
  return {
    scope,
    canManage:
      principal.writable &&
      settings.available &&
      settings.settings.cloud &&
      nativeRecurringProductEnabled() &&
      !!partition &&
      nativeOnceReady(partition.activation),
  };
}
async function currentWrite(
  tx: Tx,
  context: RequestContext,
  sessionId: string,
  operationId: string,
) {
  await acquireDevAdmission(tx);
  const scope = await readScheduleBrowserScope(tx, context, sessionId);
  const principal = await lockSchedulePrincipal(tx, scope, operationId, {
    ...context,
    workspaceId: scope.workspaceId,
  });
  const settings = await readWorkAutomation(tx, {
    ...scope,
    userId: scope.ownerId,
  });
  if (!settings.available || !settings.settings.cloud)
    throw new DataAccessError('authorization_denied');
  const target = await readScheduleTarget(tx, scope, sessionId);
  await lockScheduleTarget(tx, scope, target);
  if (!nativeRecurringProductEnabled())
    throw new NativeRecurringProductError('disabled');
  return { scope, principal, target };
}
export async function readRecurringOccurrenceRows(
  tx: Tx,
  p: Plan,
  before: ReturnType<typeof cursor>,
  limit: number,
) {
  return tx<
    {
      occurrence_id: string;
      revision: number;
      scheduled_at: Date;
      cursor_at: string;
      outbox_state: string;
      outbox_reason: string | null;
      run_id: string | null;
      run_state: string | null;
      error_message: string | null;
    }[]
  >`
    select o.occurrence_id,o.revision,o.scheduled_at,to_char(o.scheduled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,
      o.outbox_state,o.outbox_reason,r.id run_id,r.state run_state,j.last_error_message error_message
    from allrice_native_recurring_occurrences o
    left join allrice_automation_runs ar on ar.native_recurring_occurrence_id=o.occurrence_id and ar.automation_id=o.automation_id
    left join allrice_runs r on r.id=ar.run_id and r.organization_id=${p.organization_id} and r.workspace_id=${p.workspace_id} and r.owner_id=${p.owner_id}
    left join allrice_jobs j on j.run_id=r.id
    where o.automation_id=${p.id}
      ${before ? tx`and (o.scheduled_at,o.occurrence_id)<(${before.at}::text::timestamptz,${before.id}::uuid)` : tx``}
    order by o.scheduled_at desc,o.occurrence_id desc limit ${limit}`;
}
export function recurringOccurrenceProjection(
  p: Plan,
  o: Awaited<ReturnType<typeof readRecurringOccurrenceRows>>[number],
): RecurringOccurrence {
  const status = o.run_id
    ? o.run_state === 'succeeded'
      ? 'succeeded'
      : o.run_state === 'failed'
        ? 'failed'
        : o.run_state === 'canceled'
          ? 'canceled'
          : ['waiting_approval', 'waiting_input'].includes(o.run_state ?? '')
            ? 'awaiting_input'
            : o.run_state === 'running'
              ? 'running'
              : 'queued'
    : o.outbox_state === 'blocked'
      ? 'not_executed'
      : 'pending';
  return RecurringOccurrenceSchema.parse({
    id: o.occurrence_id,
    taskId: p.id,
    revision: Number(o.revision),
    scheduledAt: o.scheduled_at.toISOString(),
    status,
    runId: o.run_id,
    errorMessage:
      o.outbox_state === 'blocked'
        ? o.outbox_reason === 'paused_or_deleted'
          ? '本期处于暂停或删除状态，未执行。'
          : o.outbox_reason === 'before_resume_watermark'
            ? '恢复之前的周期不补发。'
            : '本期权限或任务配置发生变化，未执行。'
        : o.error_message,
  });
}
export async function readRecurringTaskProjection(
  tx: Tx,
  p: Plan,
  canManage: boolean,
): Promise<RecurringTask> {
  const [c] = await tx<
    ControlRow[]
  >`select partition_id,control_id,snapshot from allrice_native_recurring_controls where automation_id=${p.id}`;
  const control = c?.snapshot.control,
    native = c?.snapshot.task as { record?: { scheduledAt?: string } } | null;
  const status = p.deleted_at
    ? control?.taskDeleted || control?.command.status === 'confirmed'
      ? 'deleted'
      : 'deleting'
    : p.status === 'paused'
      ? 'paused'
      : control?.command.status === 'blocked'
        ? 'failed'
        : control?.command.status !== 'confirmed'
          ? 'preparing'
          : 'enabled';
  const [latest] = await readRecurringOccurrenceRows(tx, p, null, 1);
  return RecurringTaskSchema.parse({
    id: p.id,
    clientRequestId: p.native_recurring_request_id,
    sessionId: p.session_id,
    name: p.name,
    prompt: p.prompt,
    rule: p.schedule.rule,
    revision: Number(p.revision),
    status,
    nextRunAt:
      status === 'enabled' ? (native?.record?.scheduledAt ?? null) : null,
    errorMessage:
      status === 'failed' ? '定时任务准备失败，请查看诊断后重新安排。' : null,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
    canManage: canManage && ['enabled', 'paused'].includes(status),
    latestOccurrence: latest ? recurringOccurrenceProjection(p, latest) : null,
  });
}
async function originalRequest(
  tx: Tx,
  p: Plan,
): Promise<CreateRecurringTaskInput> {
  const [v] = await tx<
    { configuration: NativeRecurringRevision }[]
  >`select configuration from allrice_native_recurring_versions where automation_id=${p.id} and revision=1`;
  if (!v) throw new NativeRecurringProductError('binding_conflict');
  return CreateRecurringTaskInputSchema.parse({
    clientRequestId: p.native_recurring_request_id,
    name: v.configuration.name,
    prompt: v.configuration.prompt,
    rule: v.configuration.rule,
  });
}
async function readOperation(
  tx: Tx,
  op: OperationRow,
  p: Plan,
  canManage: boolean,
) {
  return RecurringTaskOperationSchema.parse({
    operationId: op.operation_id,
    taskId: op.automation_id,
    request: op.request,
    status: op.status,
    errorMessage: op.error_message,
    task: await readRecurringTaskProjection(tx, p, canManage),
  });
}
export async function createRecurringTask(
  contextInput: RequestContext,
  sessionId: string,
  raw: unknown,
) {
  const context = RequestContextSchema.parse(contextInput),
    input = CreateRecurringTaskInputSchema.parse(raw);
  return getDatabase().begin(async (tx) => {
    const { scope, target } = await currentWrite(
      tx,
      context,
      sessionId,
      input.clientRequestId,
    );
    const digest = runtimePolicyDigest({ sessionId, ...input });
    return enrollRecurringTask(tx, scope, target, sessionId, input, digest);
  });
}

/** Shared browser/chat enrollment. The caller holds current principal and
 * target locks; chat authority and the write remain in this same transaction. */
async function enrollRecurringTask(
  tx: Tx,
  scope: ScheduleScope,
  target: ScheduleTarget,
  sessionId: string,
  input: CreateRecurringTaskInput,
  digest: string,
  validateNew?: () => void,
) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`recurring-create:${scope.organizationId}:${scope.ownerId}:${input.clientRequestId}`},0))`;
  const [existing] = await tx<
    Plan[]
  >`select * from allrice_automations where organization_id=${scope.organizationId} and owner_id=${scope.ownerId}
      and clock_owner='native_recurring' and native_recurring_request_id=${input.clientRequestId} for update`;
  if (existing) {
    if (
      existing.native_recurring_request_digest !== digest ||
      existing.session_id !== sessionId
    )
      throw new NativeRecurringProductError('request_conflict');
    return readRecurringTaskProjection(tx, existing, true);
  }
  validateNew?.();
  const [partition] = await tx<
    { partition_id: string; activation: NativeOnceReadiness }[]
  >`
      select partition_id,activation from allrice_native_once_partitions where partition_id='allrice-recurring-v1' for share`;
  if (!partition || !nativeOnceReady(partition.activation))
    throw new NativeRecurringProductError('disabled');
  const [count] = await tx<
    { count: number }[]
  >`select count(*)::int count from allrice_automations where organization_id=${scope.organizationId}
      and owner_id=${scope.ownerId} and clock_owner='native_recurring' and deleted_at is null`;
  if (count!.count >= 1000) throw new NativeRecurringProductError('limit');
  const [p] = await tx<Plan[]>`insert into allrice_automations
      (organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,session_id,
       next_run_at,clock_owner,native_recurring_request_id,native_recurring_request_digest,native_recurring_revision)
      values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${input.name},${input.prompt},'schedule',
        ${json(tx, { frequency: 'native_recurring', rule: input.rule })},'enabled','reuse',${target.employee_assignment_id},${sessionId},
        null,'native_recurring',${input.clientRequestId},${digest},1) returning *`;
  const control: NativeRecurringControl = {
    kind: 'recurring',
    partitionId: partition.partition_id,
    controlId: randomUUID(),
    ...scope,
    automationId: p!.id,
    revision: 1,
    controlSessionId: `recurring-${randomUUID()}`,
    rule: input.rule,
    appliedRevision: null,
    appliedRule: null,
    sessionState: 'reserved',
    nativeTaskId: null,
    taskDeleted: false,
    command: { id: randomUUID(), kind: 'create', status: 'pending' },
    dispatch: {
      employeeAssignmentId: target.employee_assignment_id,
      employeeInstanceId: target.employee_instance_id,
      businessSessionId: sessionId,
    },
  };
  const version = {
    revision: 1,
    name: input.name,
    prompt: input.prompt,
    rule: input.rule,
    acceptedAt: p!.created_at.toISOString(),
  };
  await tx`insert into allrice_native_recurring_versions(automation_id,revision,configuration) values(${p!.id},1,
      ${json(tx, { ...version, reservationDigest: reservation(p!, control, version) })})`;
  await tx`insert into allrice_native_recurring_controls(partition_id,control_id,automation_id,control_session_id,immutable_identity,snapshot)
      values(${control.partitionId},${control.controlId},${p!.id},${control.controlSessionId},${json(tx, recurringControlIdentity(control))},${json(tx, { control, task: null })})`;
  await audit(tx, scope, p!.id, 'create');
  return readRecurringTaskProjection(tx, p!, true);
}

export async function createRecurringTaskFromExecutionContext(
  input: EmployeeChatCall & {
    name: string;
    prompt: string;
    rule: RecurringScheduleRule;
  },
) {
  const { ctx, scope } = employeeChatIdentity(input);
  const rule = RecurringScheduleRuleSchema.parse(input.rule);
  if (
    !ctx.policySnapshot.grants.some(
      (grant) =>
        grant.resourceType === 'automation' &&
        grant.action === 'resource:write' &&
        (grant.workspaceId === null || grant.workspaceId === scope.workspaceId),
    )
  )
    throw new DataAccessError('authorization_denied');
  const requestId = employeeChatUuid(
    'native-recurring-call',
    ctx.organizationId,
    ctx.workspaceId!,
    ctx.runId,
    input.callId,
  );
  // The original arguments are part of the identity, even though the model's
  // prompt is never used as a replacement for the authorized human request.
  const digest = runtimePolicyDigest({
    kind: 'native-recurring-call',
    runId: ctx.runId,
    callId: input.callId,
    sessionId: input.sessionId,
    name: input.name,
    prompt: input.prompt,
    rule,
    arguments: input.arguments,
  });
  return employeeAccessTransaction(getDatabase(), async (tx) => {
    await tx`set local lock_timeout='1000ms'`;
    await tx`set local statement_timeout='10000ms'`;
    await acquireDevAdmission(tx);
    const ownerScope = {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      ownerId: scope.actor.id,
    };
    await lockSchedulePrincipal(tx, ownerScope, requestId);
    const work = await readWorkAutomation(tx, {
      ...ownerScope,
      userId: ownerScope.ownerId,
    });
    if (!work.available || !work.settings.cloud)
      throw new DataAccessError('authorization_denied');
    const target = await readScheduleTarget(tx, ownerScope, input.sessionId);
    const instance = await lockScheduleTarget(tx, ownerScope, target);
    const current = await assertEmployeeChatExecution(
      tx,
      input,
      instance,
      'automation.create',
    );
    await assertEmployeeChatHumanSource(tx, input, current);
    if (!nativeRecurringProductEnabled())
      throw new NativeRecurringProductError('disabled');
    const clarified = await readScheduleClarification(tx, input, current.text);
    const intent = clarified
      ? clarified.intent?.kind === 'recurring'
        ? clarified.intent
        : null
      : explicitRecurringTaskIntent(current.text);
    const authoritativeRequest = intent?.authoritativeRequest ?? current.text;
    const enrollment = CreateRecurringTaskInputSchema.parse({
      clientRequestId: requestId,
      name: input.name,
      prompt: authoritativeRequest,
      rule,
    });
    return enrollRecurringTask(
      tx,
      ownerScope,
      target,
      input.sessionId,
      // Preserve the original work and, when used, the actual human selection.
      { ...enrollment, prompt: authoritativeRequest },
      digest,
      () => {
        if (!intent) throw new NativeRecurringProductError('intent_required');
        if (!isDeepStrictEqual(rule, intent.rule))
          throw new NativeRecurringProductError('rule_mismatch');
      },
    );
  });
}
async function audit(tx: Tx, scope: ScheduleScope, id: string, action: string) {
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason)
    values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${`automation.${action}`},'automation',${id},'allowed','native_recurring_management')`;
}
export async function listRecurringTasks(
  contextInput: RequestContext,
  sessionId: string,
  raw: unknown = {},
) {
  const context = RequestContextSchema.parse(contextInput),
    query = RecurringTaskListQuerySchema.parse(raw),
    before = cursor(query.cursor);
  return getDatabase().begin(async (tx) => {
    const { scope, canManage } = await currentRead(tx, context, sessionId);
    const rows = await tx<
      (Plan & { cursor_at: string })[]
    >`select *,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
      from allrice_automations where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and session_id=${sessionId} and clock_owner='native_recurring'
      ${query.clientRequestId ? tx`and native_recurring_request_id=${query.clientRequestId}` : tx``}
      ${before ? tx`and (created_at,id)<(${before.at}::text::timestamptz,${before.id}::uuid)` : tx``}
      order by created_at desc,id desc limit 51`;
    const page = rows.slice(0, 50),
      last = page.at(-1);
    return {
      tasks: await Promise.all(
        page.map((p) => readRecurringTaskProjection(tx, p, canManage)),
      ),
      request:
        query.clientRequestId && page[0]
          ? await originalRequest(tx, page[0])
          : null,
      enabled: canManage,
      nextCursor:
        rows.length > 50 && last ? encodeCursor(last.cursor_at, last.id) : null,
    };
  });
}
export async function getRecurringTask(
  contextInput: RequestContext,
  sessionId: string,
  taskId: string,
  raw: unknown = {},
  includeArchived = false,
) {
  const context = RequestContextSchema.parse(contextInput),
    query = RecurringTaskDetailQuerySchema.parse(raw),
    before = cursor(query.cursor);
  UuidSchema.parse(taskId);
  return getDatabase().begin(async (tx) => {
    const { scope, canManage } = await currentRead(
      tx,
      context,
      sessionId,
      includeArchived,
    );
    const [p] = await tx<
      Plan[]
    >`select * from allrice_automations where id=${taskId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and session_id=${sessionId} and clock_owner='native_recurring'`;
    if (!p) throw new DataAccessError('not_found');
    if (query.operationId) {
      const [op] = await tx<
        OperationRow[]
      >`select * from allrice_native_recurring_operations where organization_id=${scope.organizationId}
        and owner_id=${scope.ownerId} and operation_id=${query.operationId} and automation_id=${p.id}`;
      return {
        operation: op ? await readOperation(tx, op, p, canManage) : null,
      };
    }
    const rows = await readRecurringOccurrenceRows(tx, p, before, 51),
      page = rows.slice(0, 50),
      last = page.at(-1);
    return {
      task: await readRecurringTaskProjection(tx, p, canManage),
      occurrences: page.map((o) => recurringOccurrenceProjection(p, o)),
      nextCursor:
        rows.length > 50 && last
          ? encodeCursor(last.cursor_at, last.occurrence_id)
          : null,
    };
  });
}
export async function changeRecurringTask(
  contextInput: RequestContext,
  sessionId: string,
  taskId: string,
  raw: unknown,
  catalogStop = false,
) {
  const context = RequestContextSchema.parse(contextInput),
    input = ChangeRecurringTaskInputSchema.parse(raw);
  UuidSchema.parse(taskId);
  return getDatabase().begin(async (tx) => {
    // Stopping owned work must remain possible after its source was archived
    // or cloud execution disabled. This grants no enrollment, edit or resume.
    const stopping = catalogStop && ['pause', 'delete'].includes(input.action);
    const scope = stopping
      ? await readScheduleBrowserScope(tx, context, sessionId, true)
      : (await currentWrite(tx, context, sessionId, input.operationId)).scope;
    if (stopping) {
      await acquireDevAdmission(tx);
      await lockSchedulePrincipal(tx, scope, input.operationId, {
        ...context,
        workspaceId: scope.workspaceId,
      });
    }
    const digest = runtimePolicyDigest({ sessionId, taskId, input });
    await tx`select pg_advisory_xact_lock(hashtextextended(${`recurring-operation:${scope.organizationId}:${scope.ownerId}:${input.operationId}`},0))`;
    const [p] = await tx<
      Plan[]
    >`select * from allrice_automations where id=${taskId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and session_id=${sessionId} and clock_owner='native_recurring' for update`;
    if (!p) throw new DataAccessError('not_found');
    const [existing] = await tx<
      OperationRow[]
    >`select * from allrice_native_recurring_operations where organization_id=${scope.organizationId}
      and owner_id=${scope.ownerId} and operation_id=${input.operationId}`;
    if (existing) {
      if (
        existing.request_digest !== digest ||
        existing.automation_id !== p.id ||
        !isDeepStrictEqual(existing.request, input)
      )
        throw new NativeRecurringProductError('request_conflict');
      return readOperation(tx, existing, p, true);
    }
    const [c] = await tx<
      ControlRow[]
    >`select partition_id,control_id,snapshot from allrice_native_recurring_controls where automation_id=${p.id} for update`;
    if (!c) throw new NativeRecurringProductError('binding_conflict');
    const control = NativeRecurringControlSchema.parse(c.snapshot.control);
    const reason =
      Number(p.revision) !== input.expectedRevision
        ? '任务已被其他页面更新，请查看最新设置后重新选择。'
        : p.deleted_at
          ? '任务已删除，历史记录仍可查看。'
          : control.command.status === 'pending'
            ? '上一项操作仍在确认，请稍后查看结果。'
            : input.action === 'pause' && p.status !== 'enabled'
              ? '任务当前已暂停。'
              : input.action === 'resume' && p.status !== 'paused'
                ? '任务当前已启用。'
                : null;
    const [op] = await tx<
      OperationRow[]
    >`insert into allrice_native_recurring_operations
      (organization_id,owner_id,operation_id,automation_id,request,request_digest,status,error_message)
      values(${scope.organizationId},${scope.ownerId},${input.operationId},${p.id},${json(tx, input)},${digest},${reason ? 'rejected' : 'pending'},${reason}) returning *`;
    if (reason) return readOperation(tx, op!, p, true);
    const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
    const nextRevision = Number(p.revision) + 1;
    if (!Number.isSafeInteger(nextRevision))
      throw new NativeRecurringProductError('limit');
    if (input.action === 'update') {
      const version = {
        revision: nextRevision,
        name: input.name,
        prompt: input.prompt,
        rule: input.rule,
        acceptedAt: clock!.now.toISOString(),
      };
      await tx`insert into allrice_native_recurring_versions(automation_id,revision,configuration) values(${p.id},${nextRevision},
        ${json(tx, { ...version, reservationDigest: reservation(p, control, version) })})`;
      await tx`update allrice_automations set name=${input.name},prompt=${input.prompt},schedule=${json(tx, { frequency: 'native_recurring', rule: input.rule })},
        revision=${nextRevision},native_recurring_revision=${nextRevision},updated_at=clock_timestamp() where id=${p.id}`;
      control.revision = nextRevision;
      control.rule = input.rule;
      control.command = {
        id: input.operationId,
        kind: 'update',
        status: 'pending',
      };
    } else if (input.action === 'delete') {
      await tx`update allrice_automations set deleted_at=clock_timestamp(),status='paused',next_run_at=null,revision=${nextRevision},updated_at=clock_timestamp() where id=${p.id}`;
      control.command = {
        id: input.operationId,
        kind: 'delete',
        status: 'pending',
      };
    } else {
      await tx`update allrice_automations set status=${input.action === 'pause' ? 'paused' : 'enabled'},revision=${nextRevision},
        native_recurring_resume_after=${input.action === 'resume' ? clock!.now : p.native_recurring_resume_after},updated_at=clock_timestamp() where id=${p.id}`;
      await tx`update allrice_native_recurring_operations set status='applied',updated_at=clock_timestamp()
        where organization_id=${scope.organizationId} and owner_id=${scope.ownerId} and operation_id=${input.operationId}`;
    }
    if (input.action === 'update' || input.action === 'delete')
      await tx`update allrice_native_recurring_controls set snapshot=${json(tx, { ...c.snapshot, control })},snapshot_version=snapshot_version+1
        where partition_id=${c.partition_id} and control_id=${c.control_id}`;
    // Plan lock linearizes with dispatch. Work already enqueued remains valid.
    await tx`update allrice_native_recurring_occurrences set outbox_state='blocked',outbox_reason=${input.action === 'update' ? 'configuration_changed' : 'paused_or_deleted'}
      where automation_id=${p.id} and outbox_state='pending'`;
    await audit(tx, scope, p.id, input.action);
    const [updated] = await tx<
      Plan[]
    >`select * from allrice_automations where id=${p.id}`;
    const [final] = await tx<
      OperationRow[]
    >`select * from allrice_native_recurring_operations where organization_id=${scope.organizationId}
      and owner_id=${scope.ownerId} and operation_id=${input.operationId}`;
    return readOperation(tx, final!, updated!, true);
  });
}

/** Current authority is locked before the Host partition/control. A synthetic
 * control receipt never grants access to a business employee by itself. */
export async function lockNativeRecurringAdmissions(
  tx: Tx,
  controls: readonly NativeRecurringControl[],
) {
  const result = new Map<string, NativeRecurringAdmission>();
  for (const c of [...controls].sort((a, b) =>
    `${a.organizationId}:${a.ownerId}:${a.automationId}`.localeCompare(
      `${b.organizationId}:${b.ownerId}:${b.automationId}`,
    ),
  )) {
    if ('consumer' in c.dispatch) {
      const admission = await lockPlatformQualityNativeAdmission(tx, c);
      if (admission) result.set(c.controlId, admission);
      continue;
    }
    const scope = scopeOf(c),
      principal = await readContentPrincipal(
        scheduleIdentity(scope),
        tx,
        'update_user',
      );
    const settings = await readWorkAutomation(tx, {
      ...scope,
      userId: scope.ownerId,
    });
    const [p] = await tx<
      Plan[]
    >`select * from allrice_automations where id=${c.automationId} and organization_id=${scope.organizationId}
      and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} for update`;
    if (!p) continue;
    let allowed =
      !!principal?.writable &&
      settings.available &&
      settings.settings.cloud &&
      p.clock_owner === 'native_recurring';
    if (allowed) {
      const [target] = await tx`select s.id from allrice_employee_assignments a
        join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
        join allrice_employee_instances i on i.id=${c.dispatch.employeeInstanceId} and i.assignment_id=a.id and i.owner_id=a.user_id
        join allrice_chat_sessions s on s.id=${c.dispatch.businessSessionId} and s.employee_assignment_id=a.id
          and coalesce(s.employee_instance_id,s.employee_assignment_id)=i.id and s.organization_id=a.organization_id and s.workspace_id=a.workspace_id and s.owner_id=a.user_id
        where a.id=${c.dispatch.employeeAssignmentId} and a.organization_id=${scope.organizationId} and a.workspace_id=${scope.workspaceId} and a.user_id=${scope.ownerId}
          and a.active and e.status='active' and e.employee_key not like 'platform-%' and i.archived_at is null and s.archived_at is null for share of a,e,i,s`;
      allowed =
        !!target &&
        p.session_id === c.dispatch.businessSessionId &&
        p.employee_assignment_id === c.dispatch.employeeAssignmentId;
    }
    result.set(c.controlId, {
      allowed,
      currentRevision: Number(p.native_recurring_revision),
      status: p.deleted_at ? 'deleted' : p.status,
      resumeAfter: p.native_recurring_resume_after?.toISOString() ?? null,
    });
  }
  return result;
}
export async function initializeNativeRecurringPartition(
  reference: NativeOnceReference,
) {
  let approved: unknown;
  try {
    approved = JSON.parse(
      process.env.ALLRICE_NATIVE_RECURRING_REFERENCE ?? 'null',
    );
  } catch {
    approved = null;
  }
  if (!nativeRecurringProductEnabled())
    throw new NativeRecurringProductError('disabled');
  if (
    !isDeepStrictEqual(approved, reference) ||
    Object.keys(reference).length !== 4 ||
    !/^sha256:[a-f0-9]{64}$/.test(reference.artifactId) ||
    reference.profileId !== 'allrice-recurring-control-v1' ||
    !reference.storageId ||
    !isAbsolute(reference.stateRoot) ||
    (await realpath(reference.stateRoot)) !== reference.stateRoot ||
    !(await stat(reference.stateRoot)).isDirectory()
  )
    throw new NativeRecurringProductError('binding_conflict');
  await access(reference.stateRoot, constants.R_OK | constants.W_OK);
  return getDatabase().begin(async (tx) => {
    const [schema] =
      await tx`select to_regclass(format('%I.allrice_native_recurring_occurrences',current_schema())) is not null as ready`;
    if (!schema?.ready) throw new NativeRecurringProductError('disabled');
    const activation = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
    await tx`insert into allrice_native_once_partitions(partition_id,reference,activation)
      values('allrice-recurring-v1',${json(tx, reference)},${json(tx, activation)}) on conflict(partition_id) do nothing`;
    const [row] = await tx<
      {
        partition_id: string;
        reference: NativeOnceReference;
        activation: NativeOnceReadiness;
      }[]
    >`
      select partition_id,reference,activation from allrice_native_once_partitions where partition_id='allrice-recurring-v1' for share`;
    if (
      !row ||
      !isDeepStrictEqual(row.reference, reference) ||
      !nativeOnceReady(row.activation)
    )
      throw new NativeRecurringProductError('binding_conflict');
    return {
      partitionId: row.partition_id,
      reference: row.reference,
      activation: {
        enabled: row.activation.enabled === true,
        storageReady: row.activation.storageReady === true,
        legacyClockExcluded: row.activation.legacyClockExcluded === true,
        controlArtifactApproved:
          row.activation.controlArtifactApproved === true,
      },
    };
  });
}

type OccurrenceRow = {
  occurrence_id: string;
  partition_id: string;
  control_id: string;
  automation_id: string;
  revision: number;
  scheduled_at: Date;
  client_message_id: string;
  payload: NativeRecurringOccurrence['payload'];
  payload_digest: string;
  outbox_state: 'pending' | 'blocked' | 'enqueued';
  outbox_owner_id: string | null;
  outbox_epoch: number;
  outbox_token_digest: string | null;
};
type DispatchReservation = {
  occurrence: OccurrenceRow;
  control: NativeRecurringControl;
  version: NativeRecurringRevision;
  principal: ResourcePrincipal;
  plan: Plan;
};
const dispatchReservations = new WeakMap<Tx, DispatchReservation>();

/** Only the exact transaction holding current product authority can create
 * the ordinary employee message. A saved receipt is not an authorization. */
export function nativeRecurringMessageReservation(
  tx: Tx,
  principal: ResourcePrincipal,
  occurrenceId: string,
) {
  const r = dispatchReservations.get(tx);
  if (
    !r ||
    'consumer' in r.control.dispatch ||
    r.occurrence.occurrence_id !== occurrenceId ||
    !isDeepStrictEqual(r.principal, principal)
  )
    throw new NativeRecurringProductError('binding_conflict');
  const prompt = [
    '这项周期任务本期已经到期，请现在执行原始要求中的工作。',
    '本轮只执行工作，不要再次创建或修改周期任务。',
    `本期计划时间：${r.occurrence.payload.receipt.scheduledAt}`,
    `原始要求：\n${r.version.prompt}`,
  ].join('\n');
  return {
    workspaceId: r.plan.workspace_id,
    sessionId: r.control.dispatch.businessSessionId,
    clientMessageId: r.occurrence.client_message_id,
    prompt: prompt.length <= 40_000 ? prompt : r.version.prompt,
  };
}
export async function assertNativeRecurringQueueBinding(
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
  const input = nativeRecurringMessageReservation(tx, context, occurrenceId),
    r = dispatchReservations.get(tx)!;
  if (
    'consumer' in r.control.dispatch ||
    binding.sessionId !== input.sessionId ||
    binding.employeeAssignmentId !== r.control.dispatch.employeeAssignmentId ||
    binding.executionSnapshot.instance?.id !==
      r.control.dispatch.employeeInstanceId ||
    clientMessageId !== input.clientMessageId ||
    binding.promptSnapshot.userRequest !== input.prompt
  )
    throw new NativeRecurringProductError('binding_conflict');
  const rows =
    await tx`select id from allrice_messages where id=${binding.userMessageId} and session_id=${input.sessionId}
    and organization_id=${context.organizationId} and workspace_id=${input.workspaceId} and owner_id=${context.actor.id}
    and role='user' and client_message_id=${clientMessageId} and content->>'text'=${input.prompt}`;
  if (rows.length !== 1)
    throw new NativeRecurringProductError('binding_conflict');
}

/** Consumes immutable DSH delivery receipts, never a second wall-clock scan.
 * Receipt -> ordinary message -> Run/Job -> binding commit in one transaction. */
export async function dispatchNextNativeRecurringOccurrence(workerId: string) {
  UuidSchema.parse(workerId);
  if (!nativeRecurringProductEnabled()) return false;
  const tokenDigest = nativeOnceDigest(randomUUID()),
    db = getDatabase();
  const occurrence = await db.begin(async (tx) => {
    await acquireDevAdmission(tx);
    const [row] = await tx<
      OccurrenceRow[]
    >`select o.* from allrice_native_recurring_occurrences o
      where (o.outbox_state='pending' or (o.outbox_state='blocked' and o.payload->'control'->'dispatch'->>'consumer'='platform-quality-v1'
        and o.outbox_reason<>'QUALITY_TARGET_ALREADY_CLAIMED'
        and not exists(select 1 from allrice_automation_runs ar where ar.native_recurring_occurrence_id=o.occurrence_id))
        or (o.outbox_state='blocked' and o.payload->'control'->'dispatch'->>'consumer'='experience-consolidation-v1'
          and o.calendar_period_id is not null and not exists(select 1 from allrice_native_calendar_decisions d where d.period_id=o.calendar_period_id)))
        and (o.outbox_owner_id is null or o.outbox_expires_at<=clock_timestamp())
      order by o.created_at,o.occurrence_id limit 1 for update of o skip locked`;
    if (!row) return null;
    const [claimed] = await tx<
      OccurrenceRow[]
    >`update allrice_native_recurring_occurrences
      set outbox_owner_id=${workerId},outbox_epoch=outbox_epoch+1,outbox_token_digest=${tokenDigest},outbox_expires_at=clock_timestamp()+interval '30 seconds'
      where occurrence_id=${row.occurrence_id} returning *`;
    return claimed!;
  });
  if (!occurrence) return migrateOneLegacyQualitySchedule();
  await db.begin(async (tx) => {
    await tx`set local lock_timeout='1000ms'`;
    await tx`set local statement_timeout='10000ms'`;
    await acquireDevAdmission(tx);
    const [projection] = await tx<
      ControlRow[]
    >`select partition_id,control_id,snapshot from allrice_native_recurring_controls
      where partition_id=${occurrence.partition_id} and control_id=${occurrence.control_id}`;
    if (!projection) throw new NativeRecurringProductError('binding_conflict');
    const rawControl: unknown = projection.snapshot.control;
    if (
      rawControl &&
      typeof rawControl === 'object' &&
      'kind' in rawControl &&
      rawControl.kind === 'calendar'
    ) {
      await dispatchExperienceCalendarNative(
        tx,
        NativeCalendarControlSchema.parse(rawControl),
        occurrence,
        workerId,
        tokenDigest,
      );
      return;
    }
    const control = NativeRecurringControlSchema.parse(
      projection.snapshot.control,
    );
    if ('consumer' in control.dispatch) {
      await dispatchPlatformQualityNative(
        tx,
        control,
        occurrence,
        workerId,
        tokenDigest,
      );
      return;
    }
    const scope = scopeOf(control);
    const fact = (await lockNativeRecurringAdmissions(tx, [control])).get(
      control.controlId,
    );
    const [live] = await tx<
      OccurrenceRow[]
    >`select * from allrice_native_recurring_occurrences where occurrence_id=${occurrence.occurrence_id} for update`;
    if (
      !live ||
      live.outbox_owner_id !== workerId ||
      Number(live.outbox_epoch) !== Number(occurrence.outbox_epoch) ||
      live.outbox_token_digest !== tokenDigest ||
      live.payload_digest !== occurrence.payload_digest ||
      !isDeepStrictEqual(live.payload, occurrence.payload)
    )
      throw new NativeRecurringProductError('lease_lost');
    // Pause/update/delete may have committed after the short claim. Preserve
    // that terminal outcome; its ordinary Run has never been enqueued.
    if (live.outbox_state === 'blocked') return;
    const [lease] =
      await tx`select 1 from allrice_native_recurring_occurrences where occurrence_id=${live.occurrence_id}
      and outbox_state='pending' and outbox_expires_at>clock_timestamp()`;
    if (!lease) throw new NativeRecurringProductError('lease_lost');
    if (
      !fact?.allowed ||
      fact.status !== 'enabled' ||
      fact.currentRevision !== Number(live.revision) ||
      (fact.resumeAfter &&
        Date.parse(live.payload.receipt.scheduledAt) <=
          Date.parse(fact.resumeAfter))
    ) {
      await tx`update allrice_native_recurring_occurrences set outbox_state='blocked',outbox_reason='current_authority_or_binding_changed'
        where occurrence_id=${live.occurrence_id}`;
      return;
    }
    const principal = await lockSchedulePrincipal(
      tx,
      scope,
      live.occurrence_id,
    );
    const target = await readScheduleTarget(
      tx,
      scope,
      control.dispatch.businessSessionId,
    );
    await lockScheduleTarget(tx, scope, target);
    const [plan] = await tx<
      Plan[]
    >`select * from allrice_automations where id=${control.automationId}`;
    const [v] = await tx<
      { configuration: NativeRecurringRevision }[]
    >`select configuration from allrice_native_recurring_versions
      where automation_id=${control.automationId} and revision=${live.revision}`;
    const version = v && NativeRecurringRevisionSchema.parse(v.configuration);
    if (
      !plan ||
      !version ||
      nativeOnceDigest(live.payload) !== live.payload_digest ||
      !isDeepStrictEqual(
        live.payload.control,
        recurringControlIdentity(control),
      ) ||
      control.nativeTaskId !== live.payload.nativeTaskId ||
      Number(live.revision) !== version.revision ||
      !isDeepStrictEqual(live.payload.revision, {
        revision: version.revision,
        rule: version.rule,
        reservationDigest: version.reservationDigest,
        acceptedAt: version.acceptedAt,
      })
    )
      throw new NativeRecurringProductError('binding_conflict');
    const { reservationDigest, ...configuration } = version;
    if (reservation(plan, control, configuration) !== reservationDigest)
      throw new NativeRecurringProductError('binding_conflict');
    dispatchReservations.set(tx, {
      occurrence: live,
      control,
      version,
      plan,
      principal,
    });
    try {
      const { prepareNativeRecurringChatRunInTransaction } =
        await import('./workspace/service.ts');
      const queued = await prepareNativeRecurringChatRunInTransaction(
        tx,
        principal,
        live.occurrence_id,
      );
      const [frozen] = await tx<
        { execution_snapshot: unknown }[]
      >`select execution_snapshot from allrice_employee_runs where run_id=${queued.runId}`;
      if (!frozen) throw new NativeRecurringProductError('binding_conflict');
      const business = {
        ...queued,
        ...scope,
        sessionId: target.id,
        employeeAssignmentId: target.employee_assignment_id,
        employeeInstanceId: target.employee_instance_id,
        clientMessageId: live.client_message_id,
        payloadDigest: live.payload_digest,
        snapshotDigest: runtimePolicyDigest(frozen.execution_snapshot),
      };
      await tx`insert into allrice_automation_runs(organization_id,workspace_id,automation_id,scheduled_for,run_id,session_id,status,native_recurring_occurrence_id)
        values(${scope.organizationId},${scope.workspaceId},${plan.id},${live.payload.receipt.scheduledAt}::timestamptz,${queued.runId},${target.id},'queued',${live.occurrence_id})`;
      await tx`update allrice_native_recurring_occurrences set outbox_state='enqueued',business_binding=${json(tx, business)} where occurrence_id=${live.occurrence_id}`;
    } finally {
      dispatchReservations.delete(tx);
    }
  });
  return true;
}
