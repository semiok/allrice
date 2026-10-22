/** Shared business-intent writes; native Task journals remain independent. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql } from 'postgres';
import { nativeOnceDigest } from './native-schedule-once-state.ts';
import {
  NativeCalendarControlSchema,
  calendarControlIdentity,
  requireCalendar,
  type NativeCalendarControl,
  type NativeCalendarRevision,
} from './native-schedule-calendar-state.ts';
import {
  NativeCalendarPlanSchema,
  NativeCalendarDecisionSchema,
  calendarPlanDigest,
  calendarDecisionDigest,
  type NativeCalendarPlan,
  type NativeCalendarDecision,
} from './native-schedule-calendar-business-state.ts';
type Tx = TransactionSql;
const PARTITION = 'allrice-recurring-v1';
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));

export function calendarPlanFor(
  c: NativeCalendarControl,
  v: NativeCalendarRevision,
  P: Date,
  at: Date,
  cause: NativeCalendarPlan['cause'],
) {
  return NativeCalendarPlanSchema.parse({
    periodId: randomUUID(),
    controlId: c.controlId,
    automationId: c.automationId,
    revision: v.revision,
    businessScheduledFor: P.toISOString(),
    initialArmId: randomUUID(),
    revisionDigest: nativeOnceDigest(v),
    createdAt: at.toISOString(),
    cause,
  });
}
export async function insertCalendarPlanInTransaction(
  tx: Tx,
  plan: NativeCalendarPlan,
) {
  await tx`insert into allrice_native_calendar_plans
    (period_id,partition_id,control_id,automation_id,revision,business_scheduled_for,initial_arm_id,plan,plan_digest,created_at)
    values(${plan.periodId},${PARTITION},${plan.controlId},${plan.automationId},${plan.revision},${plan.businessScheduledFor}::timestamptz,
      ${plan.initialArmId},${json(tx, plan)},${calendarPlanDigest(plan)},${plan.createdAt}::timestamptz)`;
}
export async function insertCalendarDecisionInTransaction(
  tx: Tx,
  raw: NativeCalendarDecision,
) {
  const d = NativeCalendarDecisionSchema.parse(raw);
  await tx`insert into allrice_native_calendar_decisions
    (decision_id,period_id,kind,outcome,revision,occurrence_id,automation_run_id,successor_period_id,decision,decision_digest,decided_at)
    values(${d.decisionId},${d.periodId},${d.kind},${d.outcome},${d.revision},${d.receiptOccurrenceId},${d.automationRunId},
      ${d.successorPeriodId},${json(tx, d)},${calendarDecisionDigest(d)},${d.decidedAt}::timestamptz)`;
}

/** The caller holds its original principal/business/automation locks. Discovery
 * happens before those locks and is only a hint: Web may have closed/replaced
 * P while the Worker waited. Do not take a control/partition lock here; native
 * writes retain their business -> partition -> control order below this read. */
export async function readCurrentCalendarPlanInTransaction(
  tx: Tx,
  selected: {
    control: NativeCalendarControl;
    plan: NativeCalendarPlan;
    planDigest: string;
  },
) {
  const [fresh] = await tx<
    {
      snapshot: { control: unknown };
      snapshot_version: number | string;
      plan: NativeCalendarPlan;
      plan_digest: string;
      has_native_period: boolean;
    }[]
  >`select c.snapshot,c.snapshot_version,p.plan,p.plan_digest,
      exists(select 1 from allrice_native_calendar_periods np where np.period_id=p.period_id) has_native_period
    from allrice_native_calendar_plans p
    join allrice_native_recurring_controls c on c.partition_id=p.partition_id and c.control_id=p.control_id
      and c.automation_id=p.automation_id
    join allrice_automations a on a.id=p.automation_id
    where p.period_id=${selected.plan.periodId} and p.control_id=${selected.control.controlId}
      and p.partition_id=${selected.control.partitionId} and p.automation_id=${selected.control.automationId}
      and p.closed_decision_id is null and a.clock_owner='native_recurring'
      and a.status='enabled' and a.deleted_at is null
      and case c.immutable_identity->'dispatch'->>'consumer' when 'ordinary-monthly-v1'
        then allrice_ordinary_monthly_business_revision_proved(a.id,p.revision) else a.revision=p.revision end
      and a.native_recurring_revision=p.revision and a.next_run_at=p.business_scheduled_for`;
  if (!fresh) return null;
  const control = NativeCalendarControlSchema.parse(fresh.snapshot.control),
    plan = NativeCalendarPlanSchema.parse(fresh.plan);
  requireCalendar(
    isDeepStrictEqual(
      calendarControlIdentity(control),
      calendarControlIdentity(selected.control),
    ) &&
      isDeepStrictEqual(plan, selected.plan) &&
      fresh.plan_digest === selected.planDigest &&
      calendarPlanDigest(plan) === fresh.plan_digest,
    'plan_changed',
  );
  return {
    control,
    plan,
    planDigest: fresh.plan_digest,
    snapshotVersion: Number(fresh.snapshot_version),
    hasNativePeriod: fresh.has_native_period,
  };
}

export async function prepareCalendarRetirementsInTransaction(
  tx: Tx,
  controlId?: string,
) {
  const rows = await tx<
    {
      arm_id: string;
      business_decision_id: string;
      native_task_id: string;
      task_snapshot: { record: unknown };
    }[]
  >`
    select a.arm_id,p.business_decision_id,a.native_task_id,a.task_snapshot from allrice_native_calendar_periods p
    join allrice_native_calendar_arms a on a.period_id=p.period_id and a.arm_id=p.current_arm_id
    where p.business_decision_id is not null and a.native_task_id is not null
      and (${controlId ?? null}::uuid is null or p.control_id=${controlId ?? null}::uuid)
      and not exists(select 1 from allrice_native_calendar_retirement_intents i where i.arm_id=a.arm_id)
    order by p.period_id limit 32`;
  for (const r of rows)
    await tx`insert into allrice_native_calendar_retirement_intents
    (retirement_id,arm_id,decision_id,native_task_id,record_digest)
    values(${randomUUID()},${r.arm_id},${r.business_decision_id},${r.native_task_id},${nativeOnceDigest(r.task_snapshot.record)})
    on conflict(arm_id) do nothing`;
  return rows.length > 0;
}
