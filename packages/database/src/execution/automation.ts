import {
  AutomationSchema,
  AutomationScheduleSchema,
  FolderTriggerConfigSchema,
  CreateAutomationInputSchema,
  UpdateAutomationInputSchema,
  UuidSchema,
  type Automation,
  type AutomationRun,
  type RequestContext,
} from '@allrice/contracts';

import { DataAccessError } from '../data.ts';
import { getDatabase } from '../core/client.ts';
import { resolveWorkspaceId } from '../workspace/service.ts';

export class LegacyScheduleRetiredError extends Error {
  readonly code = 'legacy_schedule_retired';
  constructor() {
    super('legacy_schedule_retired');
  }
}

type AutomationRunStatus = AutomationRun['status'];

interface AutomationRow {
  id: string;
  clock_owner?: 'legacy' | 'native_once' | 'native_recurring';
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  description: string;
  prompt: string;
  trigger_type: 'schedule' | 'folder';
  folder: unknown;
  revision: number;
  deleted_at: Date | null;
  schedule: unknown;
  status: 'enabled' | 'paused';
  conversation_mode: 'new_each_run' | 'reuse';
  employee_assignment_id: string | null;
  session_id: string | null;
  last_session_id: string | null;
  next_run_at: Date | null;
  last_run_at: Date | null;
  last_run_status: AutomationRunStatus | null;
  created_at: Date;
  updated_at: Date;
  quality_binding: unknown | null;
  experience_binding: unknown | null;
  brand_content_binding: string | null;
}

function userId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function mapAutomation(row: AutomationRow): Automation {
  const schedule =
    row.trigger_type === 'schedule'
      ? AutomationScheduleSchema.parse(row.schedule)
      : null;
  return AutomationSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    triggerType: row.trigger_type,
    schedule,
    folder:
      row.trigger_type === 'folder'
        ? FolderTriggerConfigSchema.parse(row.folder)
        : null,
    revision: row.revision,
    status: row.status,
    conversationMode: row.conversation_mode,
    employeeAssignmentId: row.employee_assignment_id,
    lastSessionId: row.last_session_id ?? row.session_id,
    nextRunAt: row.next_run_at?.toISOString() ?? null,
    lastRunAt: row.last_run_at?.toISOString() ?? null,
    lastRunStatus: row.last_run_status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function dateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

function timeZoneOffset(date: Date, timeZone: string) {
  const parts = dateParts(date, timeZone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) -
    date.getTime()
  );
}

function zonedTimeToUtc(
  input: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  },
  timeZone: string,
) {
  const guess = new Date(
    Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute),
  );
  const first = new Date(guess.getTime() - timeZoneOffset(guess, timeZone));
  const second = new Date(guess.getTime() - timeZoneOffset(first, timeZone));
  // Resolve the offset at the destination date. A nonexistent spring-forward
  // wall time moves forward by the gap; an overlap executes only once.
  const third = new Date(guess.getTime() - timeZoneOffset(second, timeZone));
  return third.getTime() === second.getTime()
    ? second
    : new Date(Math.max(first.getTime(), second.getTime()));
}

export function nextScheduleAt(scheduleInput: unknown, after = new Date()) {
  const schedule = AutomationScheduleSchema.parse(scheduleInput);
  if (schedule.frequency === 'once') return new Date(schedule.runAt!);
  const time = schedule.time!.split(':').map(Number);
  const current = dateParts(after, schedule.timezone);
  if (schedule.frequency === 'monthly') {
    for (let offset = 0; offset < 2; offset++) {
      const month = new Date(
        Date.UTC(current.year, current.month - 1 + offset, 1),
      );
      const lastDay = new Date(
        Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
      ).getUTCDate();
      const result = zonedTimeToUtc(
        {
          year: month.getUTCFullYear(),
          month: month.getUTCMonth() + 1,
          day: Math.min(schedule.monthDay!, lastDay),
          hour: time[0]!,
          minute: time[1]!,
        },
        schedule.timezone,
      );
      if (result > after) return result;
    }
    throw Error('Invalid monthly schedule');
  }
  const candidate = new Date(
    Date.UTC(current.year, current.month - 1, current.day, time[0], time[1]),
  );
  let days = 0;
  const currentWeekday = new Date(
    Date.UTC(current.year, current.month - 1, current.day),
  ).getUTCDay();
  if (schedule.frequency === 'weekly') {
    days = ((schedule.weekday ?? 0) - currentWeekday + 7) % 7;
    if (
      days === 0 &&
      candidate.getTime() <=
        new Date(
          Date.UTC(
            current.year,
            current.month - 1,
            current.day,
            current.hour,
            current.minute,
          ),
        ).getTime()
    )
      days = 7;
  } else if (
    candidate.getTime() <=
    new Date(
      Date.UTC(
        current.year,
        current.month - 1,
        current.day,
        current.hour,
        current.minute,
      ),
    ).getTime()
  ) {
    days = 1;
  }
  candidate.setUTCDate(candidate.getUTCDate() + days);
  return zonedTimeToUtc(
    {
      year: candidate.getUTCFullYear(),
      month: candidate.getUTCMonth() + 1,
      day: candidate.getUTCDate(),
      hour: candidate.getUTCHours(),
      minute: candidate.getUTCMinutes(),
    },
    schedule.timezone,
  );
}

function canAccessWorkspace(context: RequestContext, workspaceId: string) {
  const actor = userId(context);
  return context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actor &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
}

function assertOwner(context: RequestContext, row: AutomationRow) {
  if (row.owner_id !== userId(context))
    throw new DataAccessError('authorization_denied');
}

async function getAutomationRow(
  context: RequestContext,
  workspaceId: string,
  automationId: string,
) {
  const sql = getDatabase();
  const rows = await sql<AutomationRow[]>`
    select a.*, latest.status as last_run_status,
      latest.session_id as last_session_id
    from allrice_automations a
    left join lateral (
      select r.status, r.session_id from allrice_automation_runs r
      where r.automation_id = a.id
      order by r.created_at desc
      limit 1
    ) latest on true
    where a.organization_id = ${context.organizationId}
      and a.workspace_id = ${UuidSchema.parse(workspaceId)}
      and a.id = ${UuidSchema.parse(automationId)} and a.deleted_at is null
      and a.quality_binding is null and a.experience_binding is null
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  assertOwner(context, row);
  return row;
}

async function audit(
  context: RequestContext,
  workspaceId: string,
  action: string,
  resourceId: string,
) {
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id
    ) values (
      ${context.organizationId}, ${workspaceId}, ${userId(context)}, ${action},
      'automation', ${resourceId}, 'allowed', 'automation_owner', ${context.requestId}
    )
  `;
}

export async function listAutomations(
  context: RequestContext,
  workspaceIdInput?: string,
  triggerType?: 'schedule' | 'folder',
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  if (!canAccessWorkspace(context, workspaceId))
    throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const rows = await sql<AutomationRow[]>`
    select a.*, latest.status as last_run_status,
      latest.session_id as last_session_id
    from allrice_automations a
    left join lateral (
      select r.status, r.session_id from allrice_automation_runs r
      where r.automation_id = a.id
      order by r.created_at desc
      limit 1
    ) latest on true
    where a.organization_id = ${context.organizationId}
      and a.workspace_id = ${workspaceId}
      and a.owner_id = ${userId(context)} and a.deleted_at is null
      and a.quality_binding is null and a.experience_binding is null
      and a.clock_owner<>'native_recurring'
      and (${triggerType ?? null}::text is null or a.trigger_type=${triggerType ?? null})
    order by a.updated_at desc, a.created_at desc, a.id desc
  `;
  return { workspaceId, automations: rows.map(mapAutomation) };
}

export async function createAutomation(
  context: RequestContext,
  input: unknown,
) {
  const parsed = CreateAutomationInputSchema.parse(input);
  const workspaceId = await resolveWorkspaceId(context, parsed.workspaceId);
  if (!canAccessWorkspace(context, workspaceId))
    throw new DataAccessError('authorization_denied');
  if (parsed.triggerType === 'folder') {
    const sql = getDatabase();
    const row = await sql.begin(async (tx) => {
      const { validateFolderTriggerConfiguration } =
        await import('../folder-triggers.ts');
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${context.organizationId}:${workspaceId}:${userId(context)}:folder-rules`},52))`;
      await validateFolderTriggerConfiguration(
        { ...context, workspaceId },
        parsed.folder,
        parsed.employeeAssignmentId!,
        tx,
      );
      const [count] = await tx<
        { n: number }[]
      >`select count(*)::int as n from allrice_automations where organization_id=${context.organizationId} and workspace_id=${workspaceId} and owner_id=${userId(context)} and trigger_type='folder' and deleted_at is null`;
      if (!count || count.n >= 32) throw new DataAccessError('quota_exceeded');
      const [created] = await tx<
        AutomationRow[]
      >`insert into allrice_automations(organization_id,workspace_id,owner_id,name,description,prompt,trigger_type,schedule,folder,status,conversation_mode,employee_assignment_id,next_run_at)
        values(${context.organizationId},${workspaceId},${userId(context)},${parsed.name},${parsed.description},${parsed.prompt},'folder',null,${tx.json(parsed.folder!)},${parsed.enabled ? 'enabled' : 'paused'},'new_each_run',${parsed.employeeAssignmentId!},null) returning *,null::text as last_run_status,null::uuid as last_session_id`;
      return created;
    });
    if (!row) throw new Error('automation creation failed');
    await audit(context, workspaceId, 'automation.create', row.id);
    return mapAutomation(row);
  }
  throw new LegacyScheduleRetiredError();
}

export async function updateAutomation(
  context: RequestContext,
  workspaceIdInput: string,
  automationId: string,
  input: unknown,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const current = await getAutomationRow(context, workspaceId, automationId);
  if (current.brand_content_binding) throw new DataAccessError('grant_invalid');
  if (
    current.clock_owner === 'native_once' ||
    current.clock_owner === 'native_recurring'
  )
    throw new DataAccessError('grant_invalid');
  const parsed = UpdateAutomationInputSchema.parse(input);
  if (current.trigger_type === 'folder') {
    if (
      parsed.schedule ||
      (parsed.conversationMode && parsed.conversationMode !== 'new_each_run') ||
      parsed.expectedRevision !== current.revision
    )
      throw new DataAccessError('grant_invalid');
    const expectedRevision = current.revision;
    const sql = getDatabase();
    const row = await sql.begin(async (tx) => {
      const [locked] = await tx<
        AutomationRow[]
      >`select *,null::text as last_run_status,null::uuid as last_session_id from allrice_automations where id=${current.id} and revision=${expectedRevision} and deleted_at is null for update`;
      if (!locked) throw new DataAccessError('grant_invalid');
      const folder = FolderTriggerConfigSchema.parse(
          parsed.folder ?? locked.folder,
        ),
        assignmentId =
          parsed.employeeAssignmentId === undefined
            ? locked.employee_assignment_id
            : parsed.employeeAssignmentId;
      if (!assignmentId) throw new DataAccessError('authorization_denied');
      // Pausing/deleting must remain possible while Bridge is offline. Other
      // edits and resumption require fresh current device/grant readiness.
      if (parsed.status !== 'paused') {
        const { validateFolderTriggerConfiguration } =
          await import('../folder-triggers.ts');
        await validateFolderTriggerConfiguration(
          { ...context, workspaceId },
          folder,
          assignmentId,
          tx,
        );
      }
      const [updated] = await tx<
        AutomationRow[]
      >`update allrice_automations set name=coalesce(${parsed.name ?? null},name),description=coalesce(${parsed.description ?? null},description),prompt=coalesce(${parsed.prompt ?? null},prompt),folder=${tx.json(folder)},employee_assignment_id=${assignmentId},status=coalesce(${parsed.status ?? null},status),revision=revision+1,updated_at=clock_timestamp() where id=${locked.id} returning *,null::text as last_run_status,null::uuid as last_session_id`;
      return updated;
    });
    if (!row) throw new DataAccessError('grant_invalid');
    await audit(context, workspaceId, 'automation.update', row.id);
    return mapAutomation(row);
  }
  if (
    parsed.status !== 'paused' ||
    Object.keys(parsed).some(
      (key) => !['status', 'expectedRevision'].includes(key),
    )
  )
    throw new LegacyScheduleRetiredError();
  const sql = getDatabase();
  const [row] = await sql<AutomationRow[]>`
    update allrice_automations
    set status='paused',next_run_at=null,revision=revision+1,updated_at=clock_timestamp()
    where id=${current.id} and clock_owner='legacy' and deleted_at is null
      and revision=${parsed.expectedRevision ?? current.revision}
    returning *,null::text as last_run_status,null::uuid as last_session_id
  `;
  if (!row) throw new DataAccessError('grant_invalid');
  await audit(context, workspaceId, 'automation.update', row.id);
  return mapAutomation(row);
}

export async function deleteAutomation(
  context: RequestContext,
  workspaceIdInput: string,
  automationId: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const current = await getAutomationRow(context, workspaceId, automationId);
  if (current.brand_content_binding) throw new DataAccessError('grant_invalid');
  if (
    current.clock_owner === 'native_once' ||
    current.clock_owner === 'native_recurring'
  )
    throw new DataAccessError('grant_invalid');
  const sql = getDatabase();
  if (current.trigger_type === 'folder')
    await sql`update allrice_automations set status='paused',deleted_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp() where id=${current.id}`;
  else {
    const [deleted] = await sql<{ id: string }[]>`
      update allrice_automations
      set status='paused',next_run_at=null,deleted_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
      where id=${current.id} and clock_owner='legacy' and deleted_at is null
      returning id
    `;
    if (!deleted) throw new DataAccessError('grant_invalid');
  }
  await audit(context, workspaceId, 'automation.delete', current.id);
}

export async function runAutomationNow(
  context: RequestContext,
  workspaceIdInput: string,
  automationId: string,
) {
  const workspaceId = await resolveWorkspaceId(context, workspaceIdInput);
  const row = await getAutomationRow(context, workspaceId, automationId);
  if (row.brand_content_binding) throw new DataAccessError('grant_invalid');
  if (
    row.clock_owner === 'native_once' ||
    row.clock_owner === 'native_recurring'
  )
    throw new DataAccessError('grant_invalid');
  if (row.trigger_type === 'folder') throw new DataAccessError('grant_invalid');
  throw new LegacyScheduleRetiredError();
}

export async function syncAutomationRuns() {
  const sql = getDatabase();
  await sql`
    update allrice_automation_runs ar
    set status = case
          when r.state in ('queued', 'running', 'succeeded', 'failed', 'canceled')
            then r.state
          else 'running'
        end,
        started_at = coalesce(ar.started_at, r.started_at),
        completed_at = coalesce(ar.completed_at, r.completed_at),
        error_code = r.error_code,
        error_message = r.error_message
    from allrice_runs r
    where ar.run_id = r.id
      and ar.status <> case
        when r.state in ('queued', 'running', 'succeeded', 'failed', 'canceled')
          then r.state
        else 'running'
      end
  `;
  return 0;
}
