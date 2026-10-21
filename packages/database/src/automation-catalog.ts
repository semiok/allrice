import { z } from 'zod';
import type { TransactionSql } from 'postgres';
import {
  AutomationCatalogQuerySchema,
  AutomationCatalogTaskSchema,
  AutomationScheduleSchema,
  ChangeRecurringTaskInputSchema,
  RecurringTaskDetailQuerySchema,
  RequestContextSchema,
  TimestampSchema,
  UuidSchema,
  type AutomationCatalogTask,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { acquireDevAdmission } from './dev-maintenance.ts';
import { lockSchedulePrincipal } from './native-schedule-authority.ts';
import { nextScheduleAt } from './execution/automation.ts';
import { DataAccessError } from './data.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { readWorkAutomation } from './work-automation.ts';
import {
  nativeRecurringProductEnabled,
  readRecurringTaskProjection,
  readRecurringOccurrenceRows,
  recurringOccurrenceProjection,
  changeRecurringTask,
  getRecurringTask,
  type RecurringPlan,
} from './native-schedule-recurring-product.ts';
import {
  readOnceTaskProjection,
  cancelOnceTask,
  type OncePlan,
} from './native-schedule-once-product.ts';
import {
  nativeOnceReady,
  type NativeOnceReadiness,
} from './native-schedule-once-state.ts';

type Tx = TransactionSql;
type Row = RecurringPlan &
  OncePlan & {
    employee_name: string;
    instance_id: string | null;
    source_title: string | null;
    source_archived: boolean;
    target_active: boolean;
    cursor_at: string;
    next_run_at: Date | null;
    last_run_at: Date | null;
  };
const CursorSchema = z.object({ at: TimestampSchema, id: UuidSchema }).strict();
function cursor(raw?: string) {
  if (!raw) return null;
  try {
    return CursorSchema.parse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')),
    );
  } catch {
    throw new SyntaxError('Invalid automation cursor');
  }
}
const encode = (at: string, id: string) =>
  Buffer.from(JSON.stringify({ at, id })).toString('base64url');
async function authority(tx: Tx, raw: RequestContext, workspaceId: string) {
  const context = RequestContextSchema.parse(raw);
  UuidSchema.parse(workspaceId);
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (context.workspaceId && context.workspaceId !== workspaceId)
    throw new DataAccessError('not_found');
  const scoped = { ...context, workspaceId };
  const principal = await readContentPrincipal(scoped, tx);
  if (!principal) throw new DataAccessError('authorization_denied');
  return {
    context: scoped,
    ownerId: context.actor.id,
    writable: principal.writable,
  };
}
async function rows(
  tx: Tx,
  context: RequestContext,
  ownerId: string,
  query: { query?: string; employeeId?: string; sessionId?: string },
  before: ReturnType<typeof cursor>,
  taskId?: string,
) {
  // A single tenant/owner catalog, not one request for every employee/chat.
  // Privileged background consumers and folder watchers retain their own UIs.
  return tx<Row[]>`select a.*,
    coalesce(case when i.kind='custom' then i.profile->>'name' end,v.name,e.name,'AI 员工') employee_name,
    coalesce(s.employee_instance_id,s.employee_assignment_id,a.employee_assignment_id) instance_id,
    s.title source_title,(s.archived_at is not null) source_archived,
    coalesce((s.id is not null and s.archived_at is null and ea.active and e.status='active' and i.archived_at is null),false) target_active,
    to_char(a.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
    from allrice_automations a
    left join allrice_chat_sessions s on s.id=a.session_id and s.organization_id=a.organization_id and s.workspace_id=a.workspace_id and s.owner_id=a.owner_id
    left join allrice_employee_assignments ea on ea.id=a.employee_assignment_id and ea.organization_id=a.organization_id and ea.workspace_id=a.workspace_id and ea.user_id=a.owner_id
    left join allrice_employees e on e.id=ea.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    left join allrice_employee_versions v on v.id=s.employee_version_id and v.organization_id=a.organization_id and v.workspace_id=a.workspace_id
    left join allrice_employee_instances i on i.id=coalesce(s.employee_instance_id,s.employee_assignment_id,a.employee_assignment_id) and i.assignment_id=a.employee_assignment_id and i.owner_id=a.owner_id
    where a.organization_id=${context.organizationId} and a.workspace_id=${context.workspaceId!} and a.owner_id=${ownerId}
      and a.trigger_type='schedule' and a.brand_content_binding is null and a.quality_binding is null and a.experience_binding is null
      and (e.employee_key is null or e.employee_key not like 'platform-%')
      ${taskId ? tx`and a.id=${taskId}` : tx`and a.deleted_at is null`}
      ${query.employeeId ? tx`and coalesce(s.employee_instance_id,s.employee_assignment_id,a.employee_assignment_id)=${query.employeeId}` : tx``}
      ${query.sessionId ? tx`and a.session_id=${query.sessionId}` : tx``}
      ${query.query ? tx`and (position(lower(${query.query}) in lower(a.name||' '||a.prompt||' '||coalesce(e.name,'')||' '||coalesce(v.name,'')||' '||coalesce(i.profile->>'name','')))>0)` : tx``}
      ${before ? tx`and (a.created_at,a.id)<(${before.at}::text::timestamptz,${before.id}::uuid)` : tx``}
    order by a.created_at desc,a.id desc limit ${taskId ? 1 : 51}`;
}
async function manage(
  tx: Tx,
  context: RequestContext,
  ownerId: string,
  writable: boolean,
) {
  const settings = await readWorkAutomation(tx, {
    organizationId: context.organizationId,
    workspaceId: context.workspaceId!,
    userId: ownerId,
  });
  const [partition] = await tx<
    { activation: NativeOnceReadiness }[]
  >`select activation from allrice_native_once_partitions where partition_id='allrice-recurring-v1'`;
  return (
    writable &&
    settings.available &&
    settings.settings.cloud &&
    nativeRecurringProductEnabled() &&
    !!partition &&
    nativeOnceReady(partition.activation)
  );
}
async function project(
  tx: Tx,
  row: Row,
  writable: boolean,
  canExecute: boolean,
): Promise<AutomationCatalogTask> {
  let definition: AutomationCatalogTask['definition'];
  let nextRunAt: string | null = null,
    canStop = false;
  if (row.clock_owner === 'native_recurring') {
    const task = await readRecurringTaskProjection(
      tx,
      row,
      canExecute && row.target_active,
    );
    definition = { kind: 'recurring', task };
    nextRunAt = task.nextRunAt;
    canStop = writable && !['deleted', 'deleting'].includes(task.status);
  } else if (row.clock_owner === 'native_once') {
    const task = await readOnceTaskProjection(tx, row);
    definition = {
      kind: 'once',
      task: { ...task, canCancel: task.canCancel && writable },
    };
    canStop = task.canCancel && writable;
    nextRunAt = ['preparing', 'pending'].includes(task.status)
      ? task.runAt
      : null;
  } else {
    const schedule = AutomationScheduleSchema.parse(row.schedule);
    definition = {
      kind: 'legacy',
      schedule,
      revision: Number(row.revision),
      status: row.deleted_at ? 'deleted' : row.status,
      canManage:
        writable &&
        !row.deleted_at &&
        !(schedule.frequency === 'once' && row.last_run_at),
    };
    nextRunAt = row.next_run_at?.toISOString() ?? null;
    canStop = writable && !row.deleted_at;
  }
  return AutomationCatalogTaskSchema.parse({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    employeeId: row.instance_id,
    employeeName: row.employee_name,
    sessionId: row.session_id,
    sessionTitle: row.source_title,
    sourceArchived: row.source_archived,
    createdAt: row.created_at.toISOString(),
    nextRunAt,
    canStop,
    definition,
  });
}
export async function listAutomationCatalog(
  contextInput: RequestContext,
  raw: unknown,
) {
  const query = AutomationCatalogQuerySchema.parse(raw),
    before = cursor(query.cursor);
  return getDatabase().begin(async (tx) => {
    const { context, ownerId, writable } = await authority(
      tx,
      contextInput,
      query.workspaceId,
    );
    const canExecute = await manage(tx, context, ownerId, writable);
    const all = await rows(tx, context, ownerId, query, before),
      page = all.slice(0, 50),
      last = page.at(-1);
    return {
      tasks: await Promise.all(
        page.map((row) => project(tx, row, writable, canExecute)),
      ),
      nextCursor:
        all.length > 50 && last ? encode(last.cursor_at, last.id) : null,
    };
  });
}
export async function getAutomationCatalogTask(
  contextInput: RequestContext,
  workspaceId: string,
  taskId: string,
  raw: unknown = {},
) {
  UuidSchema.parse(taskId);
  const query = RecurringTaskDetailQuerySchema.parse(raw),
    before = cursor(query.cursor);
  return getDatabase().begin(async (tx) => {
    const { context, ownerId, writable } = await authority(
      tx,
      contextInput,
      workspaceId,
    );
    const [row] = await rows(tx, context, ownerId, {}, null, taskId);
    if (!row) throw new DataAccessError('not_found');
    const task = await project(
      tx,
      row,
      writable,
      await manage(tx, context, ownerId, writable),
    );
    if (row.clock_owner === 'native_recurring') {
      const history = await readRecurringOccurrenceRows(tx, row, before, 51),
        page = history.slice(0, 50),
        last = page.at(-1);
      return {
        task,
        occurrences: page.map((o) => ({
          ...recurringOccurrenceProjection(row, o),
          sessionId: row.session_id,
        })),
        nextCursor:
          history.length > 50 && last
            ? encode(last.cursor_at, last.occurrence_id)
            : null,
      };
    }
    // One-off/legacy outcomes are read from real Runs; no synthetic completion.
    const history = await tx<
      {
        id: string;
        run_id: string | null;
        session_id: string | null;
        scheduled_for: Date;
        cursor_at: string;
        state: string | null;
        error_message: string | null;
      }[]
    >`
      select ar.id,ar.run_id,ar.session_id,ar.scheduled_for,to_char(ar.scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,
        r.state,ar.error_message from allrice_automation_runs ar
      left join allrice_runs r on r.id=ar.run_id and r.organization_id=ar.organization_id and r.workspace_id=ar.workspace_id and r.owner_id=${ownerId}
      where ar.automation_id=${row.id} and ar.organization_id=${context.organizationId} and ar.workspace_id=${workspaceId}
      ${before ? tx`and (ar.scheduled_for,ar.id)<(${before.at}::text::timestamptz,${before.id}::uuid)` : tx``}
      order by ar.scheduled_for desc,ar.id desc limit 51`;
    const page = history.slice(0, 50),
      last = page.at(-1);
    return {
      task,
      occurrences: page.map((o) => ({
        id: o.id,
        taskId: row.id,
        revision: Number(row.revision),
        scheduledAt: o.scheduled_for.toISOString(),
        status: ['succeeded', 'failed', 'canceled', 'running'].includes(
          o.state ?? '',
        )
          ? o.state
          : ['waiting_input', 'waiting_approval'].includes(o.state ?? '')
            ? 'awaiting_input'
            : o.run_id
              ? 'queued'
              : 'pending',
        runId: o.run_id,
        sessionId: o.session_id,
        errorMessage: o.error_message,
      })),
      nextCursor:
        history.length > 50 && last ? encode(last.cursor_at, last.id) : null,
    };
  });
}
export async function getAutomationCatalogOperation(
  context: RequestContext,
  workspaceId: string,
  taskId: string,
  operationId: string,
) {
  const { task } = await getAutomationCatalogTask(context, workspaceId, taskId);
  if (task.definition.kind !== 'recurring' || !task.sessionId)
    throw new DataAccessError('not_found');
  return getRecurringTask(
    context,
    task.sessionId,
    taskId,
    { operationId: UuidSchema.parse(operationId) },
    true,
  );
}
export async function changeAutomationCatalogTask(
  context: RequestContext,
  workspaceId: string,
  taskId: string,
  raw: unknown,
) {
  const result = await getAutomationCatalogTask(context, workspaceId, taskId),
    entry = result.task;
  if (entry.definition.kind === 'recurring' && entry.sessionId) {
    const input = ChangeRecurringTaskInputSchema.parse(raw);
    return {
      operation: await changeRecurringTask(
        { ...context, workspaceId },
        entry.sessionId,
        taskId,
        input,
        true,
      ),
    };
  }
  if (entry.definition.kind === 'legacy') {
    const input = z
      .discriminatedUnion('action', [
        z
          .object({
            action: z.literal('update'),
            expectedRevision: z.number().int().positive(),
            name: z.string().trim().min(1).max(160),
            prompt: z.string().trim().min(1).max(40000),
            schedule: AutomationScheduleSchema,
          })
          .strict(),
        z
          .object({
            action: z.enum(['pause', 'resume', 'delete']),
            expectedRevision: z.number().int().positive(),
          })
          .strict(),
      ])
      .parse(raw);
    // Existing legacy executor remains the sole clock. Catalog edits only
    // update its owned configuration and preserve all historical Run rows.
    await getDatabase().begin(async (tx) => {
      const { context: scoped, ownerId } = await authority(
        tx,
        context,
        workspaceId,
      );
      await acquireDevAdmission(tx);
      await lockSchedulePrincipal(
        tx,
        { organizationId: scoped.organizationId, workspaceId, ownerId },
        context.requestId,
        { ...context, workspaceId },
      );
      const [p] = await tx<
        Row[]
      >`select * from allrice_automations where id=${taskId} and organization_id=${scoped.organizationId} and workspace_id=${workspaceId} and owner_id=${ownerId} and clock_owner='legacy' and trigger_type='schedule' and brand_content_binding is null and quality_binding is null and experience_binding is null and deleted_at is null for update`;
      if (!p) throw new DataAccessError('not_found');
      if (Number(p.revision) !== input.expectedRevision)
        throw new DataAccessError('grant_invalid');
      const originalSchedule = AutomationScheduleSchema.parse(p.schedule);
      if (
        originalSchedule.frequency === 'once' &&
        p.last_run_at &&
        ['update', 'resume'].includes(input.action)
      )
        throw new DataAccessError('grant_invalid');
      const schedule =
        input.action === 'update'
          ? input.schedule
          : AutomationScheduleSchema.parse(p.schedule);
      const status =
        input.action === 'pause' || input.action === 'delete'
          ? 'paused'
          : input.action === 'resume'
            ? 'enabled'
            : p.status;
      if (status === 'enabled') {
        const [current] =
          await tx`select a.id from allrice_employee_assignments a
          join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
          where a.id=${p.employee_assignment_id} and a.organization_id=${scoped.organizationId} and a.workspace_id=${workspaceId}
            and a.user_id=${ownerId} and a.active and e.status='active' and e.employee_key not like 'platform-%'
            and (${p.session_id}::uuid is null or exists(select 1 from allrice_chat_sessions s where s.id=${p.session_id} and s.organization_id=a.organization_id and s.workspace_id=a.workspace_id and s.owner_id=a.user_id and s.archived_at is null))`;
        if (!current) throw new DataAccessError('authorization_denied');
        const settings = await readWorkAutomation(tx, {
          organizationId: scoped.organizationId,
          workspaceId,
          userId: ownerId,
        });
        if (!settings.available || !settings.settings.cloud)
          throw new DataAccessError('authorization_denied');
      }
      const next =
        status === 'paused'
          ? null
          : input.action === 'resume' || input.action === 'update'
            ? nextScheduleAt(schedule)
            : p.next_run_at;
      await tx`update allrice_automations set name=${input.action === 'update' ? input.name : p.name},prompt=${input.action === 'update' ? input.prompt : p.prompt},
        schedule=${tx.json(schedule)},status=${status},next_run_at=${next},revision=revision+1,deleted_at=${input.action === 'delete' ? new Date() : null},updated_at=clock_timestamp() where id=${p.id}`;
      await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason) values(${scoped.organizationId},${workspaceId},${ownerId},${'automation.' + input.action},'automation',${p.id},'allowed','automation_catalog_legacy_control')`;
    });
    return {
      task: (await getAutomationCatalogTask(context, workspaceId, taskId)).task,
    };
  }
  const input = z
    .object({ action: z.literal('cancel') })
    .strict()
    .parse(raw);
  if (
    entry.definition.kind !== 'once' ||
    !entry.sessionId ||
    input.action !== 'cancel'
  )
    throw new DataAccessError('grant_invalid');
  return {
    task: await cancelOnceTask(
      { ...context, workspaceId },
      entry.sessionId,
      taskId,
      true,
    ),
  };
}
