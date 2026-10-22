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
  isTerminalRunStatus,
  type AutomationCatalogTask,
  type RequestContext,
  type RunSnapshot,
  type RecurringOccurrence,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { acquireDevAdmission } from './dev-maintenance.ts';
import { lockSchedulePrincipal } from './native-schedule-authority.ts';
import { nextScheduleAt } from './execution/automation.ts';
import { DataAccessError } from './data.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import { readWorkAutomation } from './work-automation.ts';
import {
  getRun,
  QueueError,
  requestRunCancellationTransaction,
} from './execution/queue.ts';
import { isTerminalJobStatus } from './queue/policy.ts';
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
async function authority(
  tx: Tx,
  raw: RequestContext,
  workspaceId: string,
  forWrite = false,
) {
  const context = RequestContextSchema.parse(raw);
  UuidSchema.parse(workspaceId);
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (context.workspaceId && context.workspaceId !== workspaceId)
    throw new DataAccessError('not_found');
  const scoped = { ...context, workspaceId };
  const principal = await readContentPrincipal(scoped, tx, forWrite);
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
  const canRunNow = writable && settings.available && settings.settings.cloud;
  return {
    canRunNow,
    canManage:
      canRunNow &&
      nativeRecurringProductEnabled() &&
      !!partition &&
      nativeOnceReady(partition.activation),
  };
}
async function project(
  tx: Tx,
  row: Row,
  writable: boolean,
  canExecute: boolean,
  canRunNow = false,
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
    revision: Number(row.revision),
    canRunNow:
      canRunNow &&
      row.target_active &&
      !row.deleted_at &&
      ['native_once', 'native_recurring'].includes(row.clock_owner) &&
      !row.native_once_cancelled_at,
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
    const capabilities = await manage(tx, context, ownerId, writable);
    const all = await rows(tx, context, ownerId, query, before),
      page = all.slice(0, 50),
      last = page.at(-1);
    return {
      tasks: await Promise.all(
        page.map((row) =>
          project(
            tx,
            row,
            writable,
            capabilities.canManage,
            capabilities.canRunNow,
          ),
        ),
      ),
      nextCursor:
        all.length > 50 && last ? encode(last.cursor_at, last.id) : null,
    };
  });
}
function historyRunStatus(
  state: string | null,
  runId: string | null,
): RecurringOccurrence['status'] {
  switch (state) {
    case 'succeeded':
    case 'failed':
    case 'canceled':
    case 'running':
      return state;
    case 'waiting_input':
    case 'waiting_approval':
      return 'awaiting_input';
    default:
      return runId ? 'queued' : 'pending';
  }
}
async function manualHistory(
  tx: Tx,
  context: RequestContext,
  ownerId: string,
  taskId: string,
  before: ReturnType<typeof cursor>,
) {
  const rows = await tx<
    {
      id: string;
      run_id: string;
      session_id: string;
      manual_request_id: string;
      manual_revision: number;
      manual_requested_at: Date;
      cursor_at: string;
      state: string | null;
      error_message: string | null;
    }[]
  >`select ar.id,ar.run_id,ar.session_id,ar.manual_request_id,ar.manual_revision,ar.manual_requested_at,
    to_char(ar.manual_requested_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,r.state,ar.error_message
    from allrice_automation_runs ar join allrice_runs r on r.id=ar.run_id and r.organization_id=ar.organization_id and r.workspace_id=ar.workspace_id and r.owner_id=${ownerId}
    where ar.automation_id=${taskId} and ar.organization_id=${context.organizationId} and ar.workspace_id=${context.workspaceId!} and ar.manual_request_id is not null
    ${before ? tx`and (ar.manual_requested_at,ar.id)<(${before.at}::text::timestamptz,${before.id}::uuid)` : tx``}
    order by ar.manual_requested_at desc,ar.id desc limit 51`;
  return rows.map((o) => ({
    cursorAt: o.cursor_at,
    id: o.id,
    projection: {
      id: o.id,
      taskId,
      revision: Number(o.manual_revision),
      scheduledAt: o.manual_requested_at.toISOString(),
      status: historyRunStatus(o.state, o.run_id),
      runId: o.run_id,
      sessionId: o.session_id,
      errorMessage: o.error_message,
      source: {
        kind: 'manual' as const,
        requestId: o.manual_request_id,
        requestedAt: o.manual_requested_at.toISOString(),
      },
    },
  }));
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
    const capabilities = await manage(tx, context, ownerId, writable);
    const task = await project(
      tx,
      row,
      writable,
      capabilities.canManage,
      capabilities.canRunNow,
    );
    if (row.clock_owner === 'native_recurring') {
      const native = await readRecurringOccurrenceRows(tx, row, before, 51);
      const history = [
        ...native.map((o) => ({
          cursorAt: o.cursor_at,
          id: o.occurrence_id,
          projection: {
            ...recurringOccurrenceProjection(row, o),
            sessionId: row.session_id,
            source: { kind: 'native_occurrence' as const },
          },
        })),
        ...(await manualHistory(tx, context, ownerId, row.id, before)),
      ].sort((a, b) =>
        a.cursorAt === b.cursorAt
          ? a.id < b.id
            ? 1
            : a.id > b.id
              ? -1
              : 0
          : a.cursorAt < b.cursorAt
            ? 1
            : -1,
      );
      const page = history.slice(0, 50),
        last = page.at(-1);
      return {
        task,
        occurrences: page.map((o) => o.projection),
        nextCursor:
          history.length > 50 && last ? encode(last.cursorAt, last.id) : null,
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
        manual_request_id: string | null;
        manual_revision: number | null;
        manual_requested_at: Date | null;
        native_once_occurrence_id: string | null;
      }[]
    >`
      select ar.id,ar.run_id,ar.session_id,ar.scheduled_for,to_char(ar.scheduled_for at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at,
        r.state,ar.error_message,ar.manual_request_id,ar.manual_revision,ar.manual_requested_at,ar.native_once_occurrence_id from allrice_automation_runs ar
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
        revision: Number(o.manual_revision ?? row.revision),
        scheduledAt: o.scheduled_for.toISOString(),
        status: historyRunStatus(o.state, o.run_id),
        runId: o.run_id,
        sessionId: o.session_id,
        errorMessage: o.error_message,
        source:
          o.manual_request_id && o.manual_requested_at
            ? {
                kind: 'manual' as const,
                requestId: o.manual_request_id,
                requestedAt: o.manual_requested_at.toISOString(),
              }
            : {
                kind: o.native_once_occurrence_id
                  ? ('native_occurrence' as const)
                  : ('legacy_run' as const),
              },
      })),
      nextCursor:
        history.length > 50 && last ? encode(last.cursor_at, last.id) : null,
    };
  });
}
// Presentation-only identity: recurring history uses the native occurrence ID;
// once/legacy and manual history use their durable automation_run ID. The
// server verifies the persisted source and exact Run rather than inferring it
// from a native parent plan or selecting its latest Run.
const OccurrenceRunInputSchema = z
  .object({
    occurrenceId: UuidSchema,
    runId: UuidSchema,
    source: z.enum(['manual', 'native_occurrence', 'legacy_run']).optional(),
  })
  .strict();
type OccurrenceRunInput = z.infer<typeof OccurrenceRunInputSchema>;
function activeOccurrenceRun(run: RunSnapshot) {
  return (
    !isTerminalRunStatus(run.status) && !isTerminalJobStatus(run.job.status)
  );
}
async function occurrenceRunAuthority(
  tx: Tx,
  contextInput: RequestContext,
  workspaceId: string,
  taskId: string,
  input: OccurrenceRunInput,
  forWrite = false,
) {
  const access = await authority(tx, contextInput, workspaceId, forWrite);
  if (forWrite && !access.writable)
    throw new DataAccessError('authorization_denied');
  const [plan] = await rows(
    tx,
    access.context,
    access.ownerId,
    {},
    null,
    taskId,
  );
  if (!plan) throw new DataAccessError('not_found');
  // No latest-Run selection and no new scheduling authority. The same catalog
  // scope excludes privileged business consumers and other owners' plans.
  const [bound] = await tx<
    {
      state: RunSnapshot['status'];
      job_status: RunSnapshot['job']['status'];
      cancel_requested_at: Date | null;
      manual_request_id: string | null;
      native_once_occurrence_id: string | null;
      native_recurring_occurrence_id: string | null;
    }[]
  >`select r.state,j.status job_status,j.cancel_requested_at,ar.manual_request_id,ar.native_once_occurrence_id,ar.native_recurring_occurrence_id
    from allrice_automation_runs ar
    join allrice_runs r on r.id=ar.run_id and r.organization_id=ar.organization_id and r.workspace_id=ar.workspace_id and r.owner_id=${access.ownerId}
    join allrice_jobs j on j.run_id=r.id and j.organization_id=r.organization_id and j.workspace_id=r.workspace_id and j.owner_id=r.owner_id
    where ar.automation_id=${plan.id} and ar.organization_id=${access.context.organizationId} and ar.workspace_id=${workspaceId} and ar.run_id=${input.runId}
      ${
        input.source === 'manual'
          ? tx`and ar.manual_request_id is not null and ar.id=${input.occurrenceId}`
          : input.source === 'native_occurrence'
            ? tx`and ar.manual_request_id is null and ((ar.native_recurring_occurrence_id=${input.occurrenceId}
              and exists(select 1 from allrice_native_recurring_occurrences o where o.occurrence_id=ar.native_recurring_occurrence_id and o.automation_id=ar.automation_id))
              or (ar.native_once_occurrence_id is not null and ar.id=${input.occurrenceId}))`
            : input.source === 'legacy_run'
              ? tx`and ar.manual_request_id is null and ar.native_once_occurrence_id is null and ar.native_recurring_occurrence_id is null and ar.id=${input.occurrenceId}`
              : tx`and ar.manual_request_id is null and ((ar.native_recurring_occurrence_id=${input.occurrenceId}
                and exists(select 1 from allrice_native_recurring_occurrences o where o.occurrence_id=ar.native_recurring_occurrence_id and o.automation_id=ar.automation_id))
                or (ar.native_recurring_occurrence_id is null and ar.id=${input.occurrenceId}))`
      }`;
  if (!bound) throw new DataAccessError('not_found');
  return { ...access, bound };
}
/** Exact readback only; it never resubmits an uncertain stop request. */
export async function getAutomationCatalogOccurrenceRun(
  contextInput: RequestContext,
  workspaceId: string,
  taskId: string,
  raw: unknown,
) {
  UuidSchema.parse(taskId);
  const input = OccurrenceRunInputSchema.parse(raw);
  const access = await getDatabase().begin((tx) =>
    occurrenceRunAuthority(tx, contextInput, workspaceId, taskId, input),
  );
  const run = await getRun(access.context, workspaceId, input.runId);
  return {
    taskId,
    occurrenceId: input.occurrenceId,
    source: access.bound.manual_request_id
      ? 'manual'
      : access.bound.native_once_occurrence_id ||
          access.bound.native_recurring_occurrence_id
        ? 'native_occurrence'
        : 'legacy_run',
    run,
    canStop:
      access.writable && activeOccurrenceRun(run) && !run.cancelRequestedAt,
  };
}
/** Stop one already-dispatched Run through the ordinary durable cancel chain. */
export async function stopAutomationCatalogOccurrence(
  contextInput: RequestContext,
  workspaceId: string,
  taskId: string,
  raw: unknown,
) {
  UuidSchema.parse(taskId);
  const input = OccurrenceRunInputSchema.parse(raw);
  try {
    await getDatabase().begin(async (tx) => {
      const { context, bound } = await occurrenceRunAuthority(
        tx,
        contextInput,
        workspaceId,
        taskId,
        input,
        true,
      );
      // Repeated or late requests do not modify terminal results or request a
      // different Run. The normal cancel transaction owns root/job lock order,
      // usage and physical-stop receipts; this layer never synthesizes canceled.
      if (
        isTerminalRunStatus(bound.state) ||
        isTerminalJobStatus(bound.job_status) ||
        bound.cancel_requested_at
      )
        return;
      await requestRunCancellationTransaction(
        tx,
        context,
        input.runId,
        'user_requested',
      );
    });
  } catch (error) {
    if (!(error instanceof QueueError) || error.code !== 'conflict')
      throw error;
    // Completion may win after the exact binding check. The failed transaction
    // rolls back its root edits, then reads only the original, now-terminal Run.
    const receipt = await getAutomationCatalogOccurrenceRun(
      contextInput,
      workspaceId,
      taskId,
      input,
    );
    if (activeOccurrenceRun(receipt.run)) throw error;
    return receipt;
  }
  return getAutomationCatalogOccurrenceRun(
    contextInput,
    workspaceId,
    taskId,
    input,
  );
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
