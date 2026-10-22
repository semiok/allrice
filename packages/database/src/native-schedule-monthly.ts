import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import type {
  ChangeRecurringTaskInput,
  CreateRecurringTaskInput,
  MonthlyScheduleRule,
} from '@allrice/contracts';
import { readContentPrincipal } from './content-maintenance.ts';
import { readWorkAutomation } from './work-automation.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  scheduleIdentity,
  type ScheduleScope,
  type ScheduleTarget,
} from './native-schedule-authority.ts';
import {
  NativeCalendarControlSchema,
  NativeMonthlyCalendarRevisionSchema,
  calendarControlIdentity,
  requireCalendar,
  type NativeCalendarControl,
  type NativeCalendarAdmission,
  type NativeMonthlyCalendarRevision,
  type NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import {
  nativeOnceDigest,
  type NativeOnceReference,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import {
  NativeCalendarPlanSchema,
  type NativeCalendarPlan,
} from './native-schedule-calendar-business-state.ts';
import type { createNativeCalendarSqlStore } from './native-schedule-calendar-sql.ts';
import {
  calendarPlanFor,
  insertCalendarPlanInTransaction,
  insertCalendarDecisionInTransaction,
  prepareCalendarRetirementsInTransaction,
  readCurrentCalendarPlanInTransaction,
} from './native-schedule-calendar-business.ts';
import { nextMonthlyBusinessTarget } from './native-schedule-monthly-time.ts';
import type { RecurringPlan } from './native-schedule-recurring-product.ts';

type Tx = TransactionSql;
export const ordinaryMonthlyConsumer = 'ordinary-monthly-v1';
const PARTITION = 'allrice-recurring-v1';
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
export const ordinaryMonthlyEnabled = () =>
  process.env.ALLRICE_NATIVE_RECURRING_ENABLED === '1' &&
  process.env.ALLRICE_NATIVE_CALENDAR_ENABLED === '1';
export type OrdinaryMonthlyControl = NativeCalendarControl & {
  dispatch: Extract<
    NativeCalendarControl['dispatch'],
    { consumer: typeof ordinaryMonthlyConsumer }
  >;
};
export function ordinaryMonthlyControl(raw: unknown): OrdinaryMonthlyControl {
  const c = NativeCalendarControlSchema.parse(raw);
  requireCalendar(
    c.dispatch.consumer === ordinaryMonthlyConsumer,
    'consumer_invalid',
  );
  return c as OrdinaryMonthlyControl;
}
type MonthlyPlan = RecurringPlan & { next_run_at: Date | null };
const scopeOf = (c: NativeCalendarControl): ScheduleScope => ({
  organizationId: c.organizationId,
  workspaceId: c.workspaceId,
  ownerId: c.ownerId,
});
async function instant(tx: Tx) {
  const [clock] = await tx<
    { now: Date }[]
  >`select date_trunc('milliseconds',clock_timestamp()) now`;
  requireCalendar(clock, 'clock_missing');
  return clock.now;
}
function reservation(
  p: RecurringPlan,
  c: OrdinaryMonthlyControl,
  v: Omit<NativeMonthlyCalendarRevision, 'reservationDigest'>,
) {
  return nativeOnceDigest({
    ...scopeOf(c),
    automationId: p.id,
    employeeAssignmentId: c.dispatch.employeeAssignmentId,
    employeeInstanceId: c.dispatch.employeeInstanceId,
    businessSessionId: c.dispatch.businessSessionId,
    ...v,
  });
}
function versionFor(
  p: RecurringPlan,
  c: OrdinaryMonthlyControl,
  content: { name: string; prompt: string; rule: MonthlyScheduleRule },
  revision: number,
  at: Date,
) {
  const v: Omit<NativeMonthlyCalendarRevision, 'reservationDigest'> = {
    kind: 'calendar' as const,
    binding: 'rotating-at-v1' as const,
    consumer: ordinaryMonthlyConsumer,
    revision,
    rule: content.rule,
    contentDigest: runtimePolicyDigest({
      name: content.name,
      prompt: content.prompt,
    }),
    acceptedAt: at.toISOString(),
  };
  return NativeMonthlyCalendarRevisionSchema.parse({
    ...v,
    reservationDigest: reservation(p, c, v),
  });
}
async function insertMonthlyVersion(
  tx: Tx,
  automationId: string,
  v: NativeMonthlyCalendarRevision,
  content: { name: string; prompt: string },
) {
  const frozen = { name: content.name, prompt: content.prompt };
  requireCalendar(
    runtimePolicyDigest(frozen) === v.contentDigest,
    'content_changed',
  );
  await tx`insert into allrice_native_recurring_versions
    (automation_id,revision,configuration,business_content,business_content_digest)
    values(${automationId},${v.revision},${json(tx, v)},${json(tx, frozen)},${v.contentDigest})`;
}
export async function readOrdinaryMonthlyContent(
  tx: Tx,
  automationId: string,
  v: NativeMonthlyCalendarRevision,
) {
  const [saved] = await tx<
    { content: { name: string; prompt: string }; content_digest: string }[]
  >`
    select business_content content,business_content_digest content_digest from allrice_native_recurring_versions
    where automation_id=${automationId} and revision=${v.revision}`;
  requireCalendar(
    saved &&
      saved.content_digest === v.contentDigest &&
      runtimePolicyDigest(saved.content) === v.contentDigest,
    'content_changed',
  );
  return saved.content;
}

/** Current user/cloud and exact employee/chat gates mirror ordinary fixed
 * admission. A durable native receipt alone grants no business permission. */
export async function lockOrdinaryMonthlyAdmissions(
  tx: Tx,
  controls: readonly NativeCalendarControl[],
  purpose: 'initialize' | 'native' = 'native',
) {
  const result = new Map<string, NativeCalendarAdmission>();
  for (const raw of [...controls].sort((a, b) =>
    `${a.organizationId}:${a.ownerId}:${a.automationId}`.localeCompare(
      `${b.organizationId}:${b.ownerId}:${b.automationId}`,
    ),
  )) {
    if (raw.dispatch.consumer !== ordinaryMonthlyConsumer) continue;
    const c = ordinaryMonthlyControl(raw),
      scope = scopeOf(c);
    const principal = await readContentPrincipal(
      scheduleIdentity(scope),
      tx,
      'update_user',
    );
    const work = await readWorkAutomation(tx, {
      ...scope,
      userId: scope.ownerId,
    });
    const [p] = await tx<
      MonthlyPlan[]
    >`select * from allrice_automations where id=${c.automationId}
      and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} for update`;
    if (!p) continue;
    const [saved] = await tx<
      { configuration: unknown }[]
    >`select configuration from allrice_native_recurring_versions
      where automation_id=${p.id} and revision=${p.native_recurring_revision}`;
    const parsed = NativeMonthlyCalendarRevisionSchema.safeParse(
      saved?.configuration,
    );
    let allowed =
      purpose === 'native' &&
      !!principal?.writable &&
      work.available &&
      work.settings.cloud &&
      p.clock_owner === 'native_recurring' &&
      parsed.success;
    if (allowed) {
      const [target] = await tx`select s.id from allrice_employee_assignments a
        join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
        join allrice_employee_instances i on i.id=${c.dispatch.employeeInstanceId} and i.assignment_id=a.id and i.owner_id=a.user_id
        join allrice_chat_sessions s on s.id=${c.dispatch.businessSessionId} and s.employee_assignment_id=a.id
          and coalesce(s.employee_instance_id,s.employee_assignment_id)=i.id and s.organization_id=a.organization_id
          and s.workspace_id=a.workspace_id and s.owner_id=a.user_id
        where a.id=${c.dispatch.employeeAssignmentId} and a.organization_id=${scope.organizationId}
          and a.workspace_id=${scope.workspaceId} and a.user_id=${scope.ownerId} and a.active and e.status='active'
          and e.employee_key not like 'platform-%' and i.archived_at is null and s.archived_at is null for share of a,e,i,s`;
      allowed =
        !!target &&
        p.session_id === c.dispatch.businessSessionId &&
        p.employee_assignment_id === c.dispatch.employeeAssignmentId;
    }
    if (parsed.success) {
      const { reservationDigest, ...v } = parsed.data;
      allowed =
        allowed &&
        reservation(p, c, v) === reservationDigest &&
        runtimePolicyDigest({ name: p.name, prompt: p.prompt }) ===
          v.contentDigest &&
        isDeepStrictEqual(p.schedule, {
          frequency: 'native_recurring',
          rule: v.rule,
        });
    }
    result.set(c.controlId, {
      consumer: ordinaryMonthlyConsumer,
      allowed,
      currentRevision: Number(p.native_recurring_revision),
      revisionDigest: parsed.success ? nativeOnceDigest(parsed.data) : '',
      status: p.deleted_at ? 'deleted' : p.status,
      resumeAfter: p.native_recurring_resume_after?.toISOString() ?? null,
    });
  }
  return result;
}

/** Called after the original browser/chat principal, target, request identity,
 * partition readiness and owner quota checks. No native writer is minted. */
export async function enrollOrdinaryMonthlyTaskInTransaction(
  tx: Tx,
  scope: ScheduleScope,
  target: ScheduleTarget,
  sessionId: string,
  input: Omit<CreateRecurringTaskInput, 'rule'> & { rule: MonthlyScheduleRule },
  requestDigest: string,
  reference: NativeOnceReference,
): Promise<RecurringPlan> {
  requireCalendar(ordinaryMonthlyEnabled(), 'disabled');
  const now = await instant(tx),
    P = nextMonthlyBusinessTarget(input.rule, now);
  const [p] = await tx<MonthlyPlan[]>`insert into allrice_automations
    (organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,conversation_mode,
      employee_assignment_id,session_id,next_run_at,clock_owner,native_recurring_request_id,native_recurring_request_digest,native_recurring_revision)
    values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${input.name},${input.prompt},'schedule',
      ${json(tx, { frequency: 'native_recurring', rule: input.rule })},'enabled','reuse',${target.employee_assignment_id},${sessionId},
      ${P},'native_recurring',${input.clientRequestId},${requestDigest},1) returning *`;
  requireCalendar(p, 'business_missing');
  const c = ordinaryMonthlyControl({
    kind: 'calendar',
    binding: 'rotating-at-v1',
    partitionId: PARTITION,
    controlId: randomUUID(),
    ...scope,
    automationId: p.id,
    revision: 1,
    controlSessionId: `monthly-${randomUUID()}`,
    reference,
    sessionState: 'reserved',
    nativeTaskId: null,
    dispatch: {
      consumer: ordinaryMonthlyConsumer,
      employeeAssignmentId: target.employee_assignment_id,
      employeeInstanceId: target.employee_instance_id,
      businessSessionId: sessionId,
    },
  });
  const version = versionFor(p, c, input, 1, now);
  await insertMonthlyVersion(tx, p.id, version, input);
  await tx`insert into allrice_native_recurring_controls
    (partition_id,control_id,automation_id,control_session_id,native_task_id,immutable_identity,snapshot)
    values(${PARTITION},${c.controlId},${p.id},${c.controlSessionId},null,${json(tx, calendarControlIdentity(c))},${json(tx, { control: c, task: null })})`;
  await insertCalendarPlanInTransaction(
    tx,
    calendarPlanFor(c, version, P, now, {
      kind: 'request',
      requestId: input.clientRequestId,
    }),
  );
  return p;
}

/** The caller already holds current principal/target, operation identity,
 * automation and parent locks. Business cancellation never edits native Task
 * snapshots; a live Worker later deletes them through public retirement. */
export async function changeOrdinaryMonthlyTaskInTransaction(
  tx: Tx,
  p: RecurringPlan,
  raw: unknown,
  input: ChangeRecurringTaskInput,
) {
  const c = ordinaryMonthlyControl(raw);
  // Operations retain PostgreSQL microseconds, while native documents use
  // exact milliseconds. Round the saved operation up in SQL before choosing
  // acceptedAt; a JS Date would already have lost that ordering evidence.
  const [clock] = await tx<{ now: Date }[]>`select greatest(
      date_trunc('milliseconds',clock_timestamp()),
      date_trunc('milliseconds',created_at)+case when created_at=date_trunc('milliseconds',created_at)
        then interval '0 milliseconds' else interval '1 millisecond' end) now
    from allrice_native_recurring_operations where automation_id=${p.id} and operation_id=${input.operationId}
      and organization_id=${p.organization_id} and owner_id=${p.owner_id} and status='pending'`;
  requireCalendar(clock, 'operation_missing');
  const now = clock.now,
    revision = Number(p.revision) + 1;
  requireCalendar(Number.isSafeInteger(revision), 'revision_limit');
  const [previous] = await tx<
    { configuration: unknown }[]
  >`select configuration from allrice_native_recurring_versions
    where automation_id=${p.id} and revision=${p.native_recurring_revision}`;
  const old = NativeMonthlyCalendarRevisionSchema.parse(
    previous?.configuration,
  );
  const content =
    input.action === 'update'
      ? input
      : {
          ...(await readOrdinaryMonthlyContent(tx, p.id, old)),
          rule: old.rule,
        };
  requireCalendar(content.rule.kind === 'monthly', 'binding_family_changed');
  const version = versionFor(
    p,
    c,
    { ...content, rule: content.rule },
    revision,
    now,
  );
  const enabled =
    input.action === 'resume' ||
    (input.action === 'update' && p.status === 'enabled');
  const P = enabled ? nextMonthlyBusinessTarget(version.rule, now) : null;
  await insertMonthlyVersion(tx, p.id, version, content);
  await tx`update allrice_automations set name=${content.name},prompt=${content.prompt},
    schedule=${json(tx, { frequency: 'native_recurring', rule: version.rule })},status=${enabled ? 'enabled' : 'paused'},
    deleted_at=${input.action === 'delete' ? now : p.deleted_at},revision=${revision},native_recurring_revision=${revision},
    native_recurring_resume_after=${now},next_run_at=${P},updated_at=${now} where id=${p.id}`;
  const plans = await tx<
    { period_id: string }[]
  >`select period_id from allrice_native_calendar_plans
    where control_id=${c.controlId} and closed_decision_id is null for update`;
  for (const plan of plans)
    await insertCalendarDecisionInTransaction(tx, {
      decisionId: randomUUID(),
      periodId: plan.period_id,
      kind: 'operation',
      outcome: 'canceled',
      revision,
      decidedAt: now.toISOString(),
      receiptOccurrenceId: null,
      automationRunId: null,
      successorPeriodId: null,
      lease: null,
      budget: null,
      operationId: input.operationId,
    });
  await tx`update allrice_native_recurring_occurrences set outbox_state='blocked',outbox_reason='paused_or_deleted'
    where control_id=${c.controlId} and outbox_state='pending'`;
  if (P)
    await insertCalendarPlanInTransaction(
      tx,
      calendarPlanFor(c, version, P, now, {
        kind: 'operation',
        operationId: input.operationId,
      }),
    );
  await prepareCalendarRetirementsInTransaction(tx, c.controlId);
  if (input.action === 'pause' || (input.action === 'update' && !enabled))
    await tx`update allrice_native_recurring_operations set status='applied',updated_at=${now}
    where automation_id=${p.id} and operation_id=${input.operationId}`;
}

/** One accepted business intent, using the common live writer transaction.
 * No due-time scan creates business work here. */
export async function materializeOrdinaryMonthlyCalendar(
  calendar: ReturnType<typeof createNativeCalendarSqlStore>,
  writer: NativeOnceWriter,
  reference: NativeOnceReference,
) {
  return calendar.withTransaction(async (tx) => {
    if (!ordinaryMonthlyEnabled()) return false;
    const [pending] = await tx<
      {
        snapshot: { control: unknown };
        snapshot_version: number | string;
        plan: NativeCalendarPlan;
        plan_digest: string;
      }[]
    >`select c.snapshot,c.snapshot_version,p.plan,p.plan_digest from allrice_native_calendar_plans p
      join allrice_native_recurring_controls c on c.control_id=p.control_id and c.partition_id=p.partition_id
      where c.immutable_identity->'dispatch'->>'consumer'=${ordinaryMonthlyConsumer}
        and p.closed_decision_id is null
        and (not exists(select 1 from allrice_native_calendar_periods np where np.period_id=p.period_id)
          or not allrice_ordinary_monthly_authorized(p.automation_id))
      order by p.created_at,p.period_id limit 1`;
    if (pending) {
      const discovered = ordinaryMonthlyControl(pending.snapshot.control),
        selectedPlan = NativeCalendarPlanSchema.parse(pending.plan);
      requireCalendar(
        isDeepStrictEqual(discovered.reference, reference),
        'reference_changed',
      );
      const fact = (await lockOrdinaryMonthlyAdmissions(tx, [discovered])).get(
        discovered.controlId,
      );
      const fresh = await readCurrentCalendarPlanInTransaction(tx, {
        control: discovered,
        plan: selectedPlan,
        planDigest: pending.plan_digest,
      });
      if (!fresh) return false;
      const c = ordinaryMonthlyControl(fresh.control),
        plan = fresh.plan;
      if (!fact?.allowed || fact.status !== 'enabled') {
        await tx`update allrice_automations set status='paused',next_run_at=null where id=${c.automationId}`;
        await insertCalendarDecisionInTransaction(tx, {
          decisionId: randomUUID(),
          periodId: plan.periodId,
          kind: 'authority',
          outcome: 'authority_blocked',
          revision: plan.revision,
          decidedAt: (await instant(tx)).toISOString(),
          receiptOccurrenceId: null,
          automationRunId: null,
          successorPeriodId: null,
          lease: null,
          budget: null,
        });
        await prepareCalendarRetirementsInTransaction(tx, c.controlId);
        await tx`update allrice_native_recurring_operations op set status='applied',updated_at=clock_timestamp()
          where op.automation_id=${c.automationId} and op.status='pending'
            and allrice_ordinary_monthly_operation_authority_terminal_proved(op.automation_id,op.operation_id)`;
        return true;
      }
      if (fresh.hasNativePeriod) return false;
      if (c.revision < plan.revision) {
        if (c.sessionState !== 'ready') return false;
        const mutation = {
          kind: 'calendar' as const,
          action: 'apply_revision' as const,
          controlId: c.controlId,
          expectedControlVersion: fresh.snapshotVersion,
          revision: plan.revision,
          planId: plan.periodId,
          planDigest: fresh.planDigest,
        };
        const write: NativeCalendarWrite = {
          writeId: randomUUID(),
          digest: nativeOnceDigest(mutation),
          mutation,
        };
        requireCalendar(
          (await calendar.commitMutationInTransaction(tx, writer, write)) ===
            'committed',
          'revision_changed',
        );
      }
      await calendar.prepareCalendarPeriodInTransaction(tx, writer, {
        controlId: c.controlId,
        expectedRevision: plan.revision,
        periodId: plan.periodId,
        armId: plan.initialArmId,
        businessScheduledFor: plan.businessScheduledFor,
        nativeAt: plan.businessScheduledFor,
        reason: 'business_target',
        planId: plan.periodId,
      });
      return true;
    }
    // A product operation settles from durable native facts. Unknown native
    // create/delete outcomes cannot be called a completed deletion.
    const [op] = await tx<
      { operation_id: string; automation_id: string }[]
    >`select op.operation_id,op.automation_id
      from allrice_native_recurring_operations op join allrice_automations a on a.id=op.automation_id
      join allrice_native_recurring_controls c on c.automation_id=a.id
      where op.status='pending' and c.immutable_identity->'dispatch'->>'consumer'=${ordinaryMonthlyConsumer}
        and (allrice_ordinary_monthly_operation_authority_terminal_proved(op.automation_id,op.operation_id)
        or (op.request->>'action' in ('update','resume') and exists(
          select 1 from allrice_native_calendar_plans p join allrice_native_calendar_periods np on np.plan_id=p.period_id
          join allrice_native_calendar_arms arm on arm.period_id=np.period_id and arm.native_task_id is not null
          where p.control_id=c.control_id and (p.closed_decision_id is null or exists(
            select 1 from allrice_native_calendar_decisions d where d.decision_id=p.closed_decision_id and d.kind='receipt'
              and d.outcome in ('queued','already_claimed','coalesced')))
            and p.plan->'cause'=jsonb_build_object('kind','operation','operationId',op.operation_id::text)))
        or (op.request->>'action'='delete' and a.deleted_at is not null
          and not exists(select 1 from allrice_native_calendar_periods p join allrice_native_calendar_arms arm on arm.period_id=p.period_id
            where p.control_id=c.control_id and (arm.status='creating' or (arm.native_task_id is not null
              and not exists(select 1 from allrice_native_calendar_retirements r where r.arm_id=arm.arm_id))))))
      order by op.created_at,op.operation_id limit 1 for update of op skip locked`;
    if (!op) return false;
    await tx`update allrice_native_recurring_operations set status='applied',updated_at=clock_timestamp()
      where automation_id=${op.automation_id} and operation_id=${op.operation_id} and status='pending'`;
    return true;
  });
}
