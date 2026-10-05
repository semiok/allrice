import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import {
  UuidSchema,
  RequestContextSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { QueueError } from './execution/queue.ts';
import { requirePlatformAdmin } from './platform-authority.ts';
import { resolvePlatformPreviewContext } from './platform-employees/preview-context.ts';
import { cloudStableId } from './cloud-execution.ts';
import { qualityDigest } from './platform-quality-case.ts';
import {
  QualityScheduleOriginSchema,
  QualityScheduleViewSchema,
  UpdateQualityScheduleSchema,
  type QualityScheduleOrigin,
} from './platform-quality-contracts.ts';

type Tx = postgres.TransactionSql;
const reserved = {
  version: 1,
  caseId: 'project.static.v1',
  variant: 'correct',
} as const;
const reservedSchema = z
  .object({
    version: z.literal(1),
    caseId: z.literal('project.static.v1'),
    variant: z.literal('correct'),
  })
  .strict();
const dispatchWindowMs = 15 * 60_000;
type Rule = {
  id: string;
  owner_id: string;
  organization_id: string;
  workspace_id: string;
  revision: number;
  quality_binding: unknown;
  schedule: unknown;
  status: string;
  deleted_at: Date | null;
  next_run_at: Date | null;
};
function configurationDigest(rule: Rule) {
  reservedSchema.parse(rule.quality_binding);
  return qualityDigest([
    rule.id,
    rule.owner_id,
    rule.organization_id,
    rule.workspace_id,
    rule.revision,
    rule.quality_binding,
    rule.schedule,
  ]);
}
export function qualityOccurrenceRequestId(id: string) {
  return cloudStableId(`platform-quality-occurrence:${UuidSchema.parse(id)}`);
}
async function realAdminLogin(
  context: RequestContext,
  tx: Tx | ReturnType<typeof getDatabase> = getDatabase(),
) {
  const owner = await requirePlatformAdmin(context, tx);
  const [login] =
    await tx`select id from allrice_sessions where id=${context.sessionId} and user_id=${owner} and revoked_at is null and expires_at>clock_timestamp() for share`;
  if (!login) throw new DataAccessError('authorization_denied');
  return owner;
}
async function auditConfiguration(
  tx: Tx,
  context: RequestContext,
  rule: Pick<Rule, 'id' | 'organization_id' | 'workspace_id'>,
  action: string,
) {
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
    values(${rule.organization_id},${rule.workspace_id},${context.actor.id},${action},'automation',${rule.id},'allowed','platform_private_quality_schedule',${context.requestId})`;
}

export async function getPlatformQualitySchedule(context: RequestContext) {
  const owner = await requirePlatformAdmin(context),
    db = getDatabase();
  const [rule] = await db<
    Rule[]
  >`select * from allrice_automations where owner_id=${owner} and quality_binding is not null and deleted_at is null`;
  // Keep deleted history without exposing another administrator's occurrences.
  const rows =
    await db`select r.id occurrence_id,r.scheduled_for,r.status occurrence_status,r.error_code,q.*,j.status
    from allrice_automation_runs r join allrice_automations a on a.id=r.automation_id
    left join allrice_platform_quality_checks q on q.automation_run_id=r.id
    left join allrice_jobs j on j.id=q.job_id
    where a.owner_id=${owner} and a.quality_binding is not null and r.quality_occurrence is not null
    order by r.scheduled_for desc,r.id desc limit 20`;
  const { mapPlatformQualityCheck } = await import('./platform-quality.ts');
  return QualityScheduleViewSchema.parse({
    schedule: rule
      ? {
          id: rule.id,
          revision: rule.revision,
          enabled: rule.status === 'enabled',
          time: (rule.schedule as { time: string }).time,
          timezone: 'Asia/Shanghai',
          nextRunAt: rule.next_run_at?.toISOString() ?? null,
        }
      : null,
    occurrences: rows.map((row) => {
      const check = row.id ? mapPlatformQualityCheck(row) : null;
      return {
        id: row.occurrence_id,
        scheduledFor: (row.scheduled_for as Date).toISOString(),
        status: check?.status ?? row.occurrence_status,
        checkId: check?.id ?? null,
        accepted: check?.accepted ?? false,
        verdict: check?.report?.verdict ?? null,
        notExecutedReason: check ? null : (row.error_code ?? null),
      };
    }),
  });
}

export async function updatePlatformQualitySchedule(
  context: RequestContext,
  raw: unknown,
) {
  const input = UpdateQualityScheduleSchema.parse(raw),
    owner = await realAdminLogin(context);
  const { ensureQualityEmployee } = await import('./platform-quality.ts');
  // Do not restore paused/excluded assignments just to pause an existing rule.
  const employee =
    input.enabled || input.expectedRevision === 0
      ? await ensureQualityEmployee(context)
      : null;
  const { nextScheduleAt } = await import('./execution/automation.ts');
  const schedule = {
    frequency: 'daily',
    time: input.time,
    timezone: 'Asia/Shanghai',
  } as const;
  const db = getDatabase();
  await db.begin(async (tx) => {
    await realAdminLogin(context, tx);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`quality-schedule:${owner}`},71))`;
    const [current] = await tx<
      Rule[]
    >`select * from allrice_automations where owner_id=${owner} and quality_binding is not null and deleted_at is null for update`;
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new QueueError('conflict');
    let written = current;
    if (!current) {
      if (!employee) throw new DataAccessError('authorization_denied');
      const rows = await tx<
        Rule[]
      >`insert into allrice_automations(organization_id,workspace_id,owner_id,name,description,prompt,trigger_type,schedule,status,conversation_mode,employee_assignment_id,next_run_at,quality_binding)
        values(${employee.internal.organization_id},${employee.internal.workspace_id},${owner},'每日平台静态质检','平台私有固定场景，不调用模型','固定静态场景，不调用模型','schedule',${tx.json(schedule)},${input.enabled ? 'enabled' : 'paused'},'new_each_run',${employee.assignmentId},${input.enabled ? nextScheduleAt(schedule) : null},${tx.json(reserved)}) returning *`;
      written = rows[0];
    } else {
      if (
        employee &&
        (current.workspace_id !== employee.internal.workspace_id ||
          current.organization_id !== employee.internal.organization_id)
      )
        throw new DataAccessError('authorization_denied');
      await tx`update allrice_automations set schedule=${tx.json(schedule)},status=${input.enabled ? 'enabled' : 'paused'},revision=revision+1,next_run_at=${input.enabled ? nextScheduleAt(schedule) : null},employee_assignment_id=coalesce(${employee?.assignmentId ?? null}::uuid,employee_assignment_id),updated_at=clock_timestamp() where id=${current.id}`;
      // Bound Runs keep their actual outcome; only undelivered occurrences end here.
      await tx`update allrice_automation_runs set status='failed',error_code=${input.enabled ? 'QUALITY_SCHEDULE_CHANGED' : 'QUALITY_SCHEDULE_PAUSED'},error_message='配置已变更，本轮尚未派发。',completed_at=clock_timestamp() where automation_id=${current.id} and quality_occurrence is not null and run_id is null and status='queued'`;
    }
    if (!written) throw Error('QUALITY_SCHEDULE_WRITE_UNCONFIRMED');
    await auditConfiguration(
      tx,
      context,
      written,
      input.enabled ? 'automation.quality.enable' : 'automation.quality.pause',
    );
  });
  return getPlatformQualitySchedule(context);
}

export async function deletePlatformQualitySchedule(
  context: RequestContext,
  raw: unknown,
) {
  const { expectedRevision } = z
    .object({ expectedRevision: z.number().int().positive() })
    .strict()
    .parse(raw);
  const owner = await realAdminLogin(context),
    db = getDatabase();
  await db.begin(async (tx) => {
    await realAdminLogin(context, tx);
    await tx`select pg_advisory_xact_lock(hashtextextended(${`quality-schedule:${owner}`},71))`;
    const [current] = await tx<
      Rule[]
    >`select * from allrice_automations where owner_id=${owner} and quality_binding is not null and deleted_at is null for update`;
    if (!current || current.revision !== expectedRevision)
      throw new QueueError('conflict');
    await tx`update allrice_automations set status='paused',deleted_at=clock_timestamp(),next_run_at=null,revision=revision+1,updated_at=clock_timestamp() where id=${current.id}`;
    await tx`update allrice_automation_runs set status='failed',error_code='QUALITY_SCHEDULE_DELETED',error_message='配置已移除，本轮尚未派发。',completed_at=clock_timestamp() where automation_id=${current.id} and quality_occurrence is not null and run_id is null and status='queued'`;
    await auditConfiguration(tx, context, current, 'automation.quality.delete');
  });
  return getPlatformQualitySchedule(context);
}

/** Called only with the existing scheduler's rule row lock held. */
export async function claimPlatformQualityOccurrence(
  tx: Tx,
  rule: Rule,
  nextRunAt: Date,
) {
  const scheduledFor = rule.next_run_at!,
    id = randomUUID();
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  const origin = QualityScheduleOriginSchema.parse({
    ...reserved,
    automationId: rule.id,
    occurrenceId: id,
    revision: rule.revision,
    ownerId: rule.owner_id,
    organizationId: rule.organization_id,
    workspaceId: rule.workspace_id,
    scheduledFor: scheduledFor.toISOString(),
    dispatchDeadlineAt: new Date(
      scheduledFor.getTime() + dispatchWindowMs,
    ).toISOString(),
    configurationDigest: configurationDigest(rule),
  });
  const active =
    await tx`select r.id from allrice_automation_runs r left join allrice_platform_quality_checks q on q.automation_run_id=r.id
    left join allrice_jobs j on j.id=q.job_id where r.automation_id=${rule.id} and r.quality_occurrence is not null and
    ((r.run_id is null and r.status='queued' and (r.quality_occurrence->>'dispatchDeadlineAt')::timestamptz>clock_timestamp()) or j.status in ('queued','claimed','running','waiting_approval')) limit 1`;
  const reason =
    Date.parse(origin.dispatchDeadlineAt) <= clock!.now.getTime()
      ? 'QUALITY_DISPATCH_EXPIRED'
      : active.length
        ? 'QUALITY_BUSY'
        : null;
  const [row] =
    await tx`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,quality_occurrence,status,error_code,error_message,completed_at)
    values(${id},${rule.organization_id},${rule.workspace_id},${rule.id},${scheduledFor},${tx.json(origin)},${reason ? 'failed' : 'queued'},${reason},${reason ? '本轮未执行；不会补跑积压周期。' : null},${reason ? clock!.now : null})
    on conflict(automation_id,scheduled_for) where folder_event_id is null do nothing returning id`;
  // Advance directly to the future; a restart never floods missed daily runs.
  await tx`update allrice_automations set next_run_at=${nextRunAt},last_run_at=clock_timestamp(),updated_at=clock_timestamp() where id=${rule.id}`;
  return row && !reason ? String(row.id) : null;
}

/** Rule -> occurrence lock order also used by editing/deletion, all inside the
 * original enqueue transaction. No lock spans physical execution or a model. */
export async function admitScheduledQualityOccurrence(
  tx: Tx,
  context: RequestContext,
  raw: QualityScheduleOrigin,
) {
  const origin = QualityScheduleOriginSchema.parse(raw);
  const [rule] = await tx<
    Rule[]
  >`select * from allrice_automations where id=${origin.automationId} for update`;
  const [row] =
    await tx`select * from allrice_automation_runs where id=${origin.occurrenceId} for update`;
  if (
    !rule ||
    !row ||
    rule.deleted_at ||
    rule.status !== 'enabled' ||
    rule.revision !== origin.revision ||
    rule.owner_id !== origin.ownerId ||
    rule.organization_id !== origin.organizationId ||
    rule.workspace_id !== origin.workspaceId ||
    context.actor.type !== 'user' ||
    context.actor.id !== origin.ownerId ||
    context.organizationId !== origin.organizationId ||
    context.workspaceId !== origin.workspaceId ||
    row.automation_id !== rule.id ||
    row.organization_id !== origin.organizationId ||
    row.workspace_id !== origin.workspaceId ||
    (row.scheduled_for as Date).toISOString() !== origin.scheduledFor ||
    row.run_id ||
    row.status !== 'queued' ||
    qualityDigest(row.quality_occurrence) !== qualityDigest(origin) ||
    configurationDigest(rule) !== origin.configurationDigest
  )
    throw new DataAccessError('authorization_denied');
  const [clock] = await tx<{ now: Date }[]>`select clock_timestamp() now`;
  if (Date.parse(origin.dispatchDeadlineAt) <= clock!.now.getTime())
    throw new DataAccessError('grant_invalid');
}

export async function bindScheduledQualityOccurrence(
  tx: Tx,
  context: RequestContext,
  origin: QualityScheduleOrigin,
  runId: string,
  sessionId: string,
) {
  await admitScheduledQualityOccurrence(tx, context, origin);
  const rows =
    await tx`update allrice_automation_runs set run_id=${runId},session_id=${sessionId},status='queued' where id=${origin.occurrenceId} and run_id is null and status='queued' returning id`;
  if (rows.length !== 1) throw new QueueError('conflict');
}

async function committedOccurrence(id: string) {
  const [row] =
    await getDatabase()`select r.*,q.id check_id,q.run_id quality_run_id,q.session_id quality_session_id
    from allrice_automation_runs r left join allrice_platform_quality_checks q on q.automation_run_id=r.id where r.id=${id} and r.quality_occurrence is not null`;
  if (row?.run_id) {
    if (
      !row.check_id ||
      row.run_id !== row.quality_run_id ||
      row.session_id !== row.quality_session_id
    )
      throw new Error('QUALITY_OCCURRENCE_ASSOCIATION');
  }
  return row;
}

export async function dispatchPlatformQualityOccurrence(idInput: string) {
  const id = UuidSchema.parse(idInput),
    db = getDatabase(),
    initial = await committedOccurrence(id);
  if (!initial || initial.run_id || initial.status !== 'queued') return false;
  const origin = QualityScheduleOriginSchema.parse(initial.quality_occurrence);
  try {
    const internal = await db.begin(async (tx) => {
      const preview = await resolvePlatformPreviewContext(
        tx,
        {
          environment: 'platform',
          ownerId: origin.ownerId,
          workspaceId: origin.workspaceId,
        },
        origin.ownerId,
      );
      const p = preview.context;
      if (p.organization_id !== origin.organizationId)
        throw new DataAccessError('authorization_denied');
      return RequestContextSchema.parse({
        requestId: qualityOccurrenceRequestId(id),
        // Correlation only; static delegation does not fabricate a login row.
        sessionId: cloudStableId(`quality-schedule-correlation:${id}`),
        authenticatedAt: origin.scheduledFor,
        actor: { type: 'user', id: origin.ownerId },
        organizationId: origin.organizationId,
        workspaceId: origin.workspaceId,
        memberships: [
          {
            id: p.membership_id,
            userId: p.owner_id,
            organizationId: p.organization_id,
            workspaceId: p.workspace_id,
            role: p.role,
            active: true,
          },
        ],
      });
    });
    await db.begin((tx) =>
      admitScheduledQualityOccurrence(tx, internal, origin),
    );
    const { createPlatformQualityCheck } =
      await import('./platform-quality.ts');
    await createPlatformQualityCheck(
      internal,
      {
        requestId: qualityOccurrenceRequestId(id),
        caseId: origin.caseId,
        variant: origin.variant,
      },
      { scheduleOrigin: origin },
    );
    const committed = await committedOccurrence(id);
    if (!committed?.run_id) throw new Error('QUALITY_DISPATCH_UNCONFIRMED');
    return true;
  } catch (error) {
    // A successful transaction with a lost acknowledgement is still successful.
    const committed = await committedOccurrence(id);
    if (committed?.run_id) return true;
    const [rule] = await db<
      Rule[]
    >`select * from allrice_automations where id=${origin.automationId}`;
    const [clock] = await db<{ now: Date }[]>`select clock_timestamp() now`;
    const expired =
      Date.parse(origin.dispatchDeadlineAt) <= clock!.now.getTime();
    const stale =
      !rule ||
      !!rule.deleted_at ||
      rule.status !== 'enabled' ||
      rule.revision !== origin.revision;
    const permanent =
      error instanceof DataAccessError ||
      error instanceof QueueError ||
      error instanceof
        (await import('./platform-employees/preview-context.ts'))
          .PlatformPreviewContextError;
    if (expired || stale || permanent)
      await db`update allrice_automation_runs set status='failed',error_code=${expired ? 'QUALITY_DISPATCH_EXPIRED' : stale ? 'QUALITY_SCHEDULE_CHANGED' : 'QUALITY_PREPARATION_BLOCKED'},error_message='本轮未执行；权限、配置或派发期限已不满足。',completed_at=clock_timestamp() where id=${id} and run_id is null and status='queued'`;
    // Unexpected DB/preparation errors remain recoverable until the frozen deadline.
    return false;
  }
}

export async function recoverPlatformQualityOccurrences(limit = 10) {
  const rows =
    await getDatabase()`select id from allrice_automation_runs where quality_occurrence is not null and run_id is null and status='queued' order by created_at,id limit ${Math.max(1, Math.min(20, limit))}`;
  let dispatched = 0;
  for (const row of rows) {
    try {
      if (await dispatchPlatformQualityOccurrence(String(row.id))) dispatched++;
    } catch {
      /* No confirmed outcome: leave the durable occurrence for next tick. */
    }
  }
  return dispatched;
}
