import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TransactionSql as Tx } from 'postgres';
import { AutomationScheduleSchema } from '@allrice/contracts';
import { readContentPrincipal } from './content-maintenance.ts';
import { scheduleIdentity } from './native-schedule-authority.ts';
import { experienceReviewEnabled, ExperienceError } from './experience.ts';
import { DataAccessError } from './data.ts';
import { EmployeeInstanceError } from './employees/employee-instances.ts';
import { PersonalSkillError } from './employees/personal-skills.ts';
import type { JobRow } from './queue/row-mappers.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import { nextScheduleAt } from './execution/automation.ts';
import {
  readExperiencePolicy,
  reserveExperienceOccurrenceInTransaction,
  getExperienceExecutionInTransaction,
  type ExperienceScheduleRule,
} from './experience-consolidation.ts';
import {
  ExperienceAutomationBindingSchema,
  experienceConsolidationJobType,
} from './experience-consolidation-contracts.ts';
import {
  NativeCalendarControlSchema,
  NativeCalendarRevisionSchema,
  calendarAdmissionReason,
  calendarArmIdentity,
  calendarControlIdentity,
  calendarOccurrenceIdentity,
  calendarPeriodIdentity,
  requireCalendar,
  type NativeCalendarAdmission,
  type NativeCalendarArm,
  type NativeCalendarControl,
  type NativeCalendarPeriod,
  type NativeCalendarRevision,
  type NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import {
  NativeCalendarPlanSchema,
  NativeCalendarDecisionSchema,
  calendarPlanDigest,
  calendarDecisionDigest,
  type NativeCalendarPlan,
  type NativeCalendarDecision,
} from './native-schedule-calendar-business-state.ts';
import {
  nativeOnceDigest,
  type NativeOnceReference,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import type { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';

const PARTITION = 'allrice-recurring-v1';
const CONSUMER = 'experience-consolidation-v1';
type CalendarSql = NonNullable<
  ReturnType<typeof createNativeRecurringSqlStore>['calendar']
>;
type Rule = ExperienceScheduleRule & {
  revision: number;
  status: 'enabled' | 'paused';
  deleted_at: Date | null;
  clock_owner: string;
  native_recurring_revision: number | null;
  native_recurring_resume_after: Date | null;
};
const json = (tx: Tx, value: unknown) =>
  tx.json(JSON.parse(JSON.stringify(value)));
const instant = async (tx: Tx) => {
  const [r] = await tx<
    { now: Date }[]
  >`select date_trunc('milliseconds',clock_timestamp()) now`;
  requireCalendar(r, 'database_time_missing');
  return r.now;
};
export const experienceNativeCalendarEnabled = () =>
  experienceReviewEnabled() &&
  process.env.ALLRICE_NATIVE_RECURRING_ENABLED === '1' &&
  process.env.ALLRICE_NATIVE_CALENDAR_ENABLED === '1';

/** Same business order as policy updates: principal -> advisory183 -> original
 * automation -> current policy/instance. No native partition lock is held yet. */
async function lockBusiness(
  tx: Tx,
  c: NativeCalendarControl,
  purpose: 'initialize' | 'native',
) {
  const principal = await readContentPrincipal(
    scheduleIdentity(c),
    tx,
    'update_user',
  );
  await tx`select pg_advisory_xact_lock(hashtextextended(${`experience-policy:${c.organizationId}`},183))`;
  const [rule] = await tx<
    Rule[]
  >`select * from allrice_automations where id=${c.automationId}
    and organization_id=${c.organizationId} and workspace_id=${c.workspaceId} and owner_id=${c.ownerId} for update`;
  const policy = await readExperiencePolicy(c.organizationId, tx);
  const binding = ExperienceAutomationBindingSchema.safeParse(
    rule?.experience_binding,
  );
  const [target] = await tx`select i.id from allrice_employee_instances i
    join allrice_employee_assignments x on x.id=i.assignment_id and x.user_id=i.owner_id and x.active
    join allrice_employees e on e.id=x.employee_id and e.status='active'
    where i.id=${c.dispatch.employeeInstanceId} and i.assignment_id=${c.dispatch.employeeAssignmentId}
      and i.organization_id=${c.organizationId} and i.workspace_id=${c.workspaceId} and i.owner_id=${c.ownerId} and i.archived_at is null
      and exists(select 1 from allrice_memberships m where m.organization_id=i.organization_id and m.user_id=i.owner_id
        and m.active and m.role in ('member','admin') and (m.workspace_id is null or m.workspace_id=i.workspace_id))
      and not exists(select 1 from allrice_platform_employee_tenant_assignments t where t.organization_id=x.organization_id
        and t.workspace_id=x.workspace_id and t.tenant_employee_id=x.employee_id and not t.active) for share of i,x,e`;
  const admission: NativeCalendarAdmission = {
    allowed:
      (purpose === 'native' || experienceNativeCalendarEnabled()) &&
      !!principal?.writable &&
      !!target &&
      !!rule &&
      binding.success &&
      binding.data.instanceId === c.dispatch.employeeInstanceId &&
      rule.employee_assignment_id === c.dispatch.employeeAssignmentId &&
      policy.frequency !== 'off' &&
      binding.data.policyDigest === runtimePolicyDigest(policy) &&
      rule.clock_owner ===
        (purpose === 'initialize' ? 'legacy' : 'native_recurring'),
    currentRevision: Number(
      rule?.native_recurring_revision ?? rule?.revision ?? 0,
    ),
    policyRevision: policy.revision,
    policyDigest: runtimePolicyDigest(policy),
    status: rule?.deleted_at ? 'deleted' : (rule?.status ?? 'deleted'),
    resumeAfter: rule?.native_recurring_resume_after?.toISOString() ?? null,
  };
  return { rule, policy, admission };
}
export async function lockExperienceCalendarAdmissions(
  tx: Tx,
  controls: readonly NativeCalendarControl[],
  purpose: 'initialize' | 'native' = 'native',
) {
  const facts = new Map<string, NativeCalendarAdmission>();
  for (const c of [...controls].sort((a, b) =>
    `${a.organizationId}:${a.ownerId}:${a.automationId}`.localeCompare(
      `${b.organizationId}:${b.ownerId}:${b.automationId}`,
    ),
  )) {
    facts.set(c.controlId, (await lockBusiness(tx, c, purpose)).admission);
  }
  return facts;
}

/** The original internal experience queue has no employee-chat Session. Keep
 * its exact durable handoff and its existing current source/policy/Skill gate
 * before the queue takes its normal root/Job locks. */
export async function lockExperienceCalendarJobAdmission(
  tx: Tx,
  job: JobRow,
  occurrenceId: string,
) {
  const payload = job.payload as {
    type?: unknown;
    input?: unknown;
  } | null;
  if (
    !experienceNativeCalendarEnabled() ||
    payload?.type !== experienceConsolidationJobType
  )
    return false;
  const principal = await readContentPrincipal(
    {
      actor: { type: 'user', id: job.owner_id },
      organizationId: job.organization_id,
      workspaceId: job.workspace_id,
    },
    tx,
    'update_user',
  );
  if (!principal?.writable) return false;
  const [proof] = await tx<
    { id: string }[]
  >`select r.id from allrice_automation_runs r
    where r.run_id=${job.run_id} and r.organization_id=${job.organization_id} and r.workspace_id=${job.workspace_id}
      and r.experience_occurrence->>'ownerId'=${job.owner_id} and r.native_recurring_occurrence_id=${occurrenceId}
      and allrice_experience_calendar_handoff_proved(${occurrenceId}::uuid)`;
  if (!proof || !isDeepStrictEqual(payload.input, { occurrenceId: proof.id }))
    return false;
  try {
    const { occurrence } = await getExperienceExecutionInTransaction(
      tx,
      job.run_id,
    );
    return (
      occurrence.id === proof.id &&
      occurrence.ownerId === job.owner_id &&
      occurrence.organizationId === job.organization_id &&
      occurrence.workspaceId === job.workspace_id
    );
  } catch (error) {
    if (
      error instanceof ExperienceError ||
      error instanceof DataAccessError ||
      error instanceof EmployeeInstanceError ||
      error instanceof PersonalSkillError
    )
      return false;
    throw error;
  }
}

function versionFor(
  rule: Rule,
  policy: Awaited<ReturnType<typeof readExperiencePolicy>>,
  at: Date,
) {
  const schedule = AutomationScheduleSchema.parse(rule.schedule);
  const binding = ExperienceAutomationBindingSchema.parse(
    rule.experience_binding,
  );
  const reservation = {
    consumer: CONSUMER,
    automationId: rule.id,
    revision: Number(rule.revision),
    schedule,
    organizationId: rule.organization_id,
    workspaceId: rule.workspace_id,
    ownerId: rule.owner_id,
    employeeAssignmentId: rule.employee_assignment_id,
    employeeInstanceId: binding.instanceId,
    policyRevision: policy.revision,
    policyDigest: runtimePolicyDigest(policy),
  };
  return NativeCalendarRevisionSchema.parse({
    kind: 'calendar',
    binding: 'rotating-at-v1',
    consumer: CONSUMER,
    revision: Number(rule.revision),
    ruleRevision: Number(rule.revision),
    schedule,
    policyRevision: policy.revision,
    policyDigest: runtimePolicyDigest(policy),
    reservationDigest: nativeOnceDigest(reservation),
    acceptedAt: at.toISOString(),
  });
}
function planFor(
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
async function insertPlan(tx: Tx, plan: NativeCalendarPlan) {
  await tx`insert into allrice_native_calendar_plans
    (period_id,partition_id,control_id,automation_id,revision,business_scheduled_for,initial_arm_id,plan,plan_digest,created_at)
    values(${plan.periodId},${PARTITION},${plan.controlId},${plan.automationId},${plan.revision},${plan.businessScheduledFor}::timestamptz,
      ${plan.initialArmId},${json(tx, plan)},${calendarPlanDigest(plan)},${plan.createdAt}::timestamptz)`;
}
async function insertDecision(tx: Tx, raw: NativeCalendarDecision) {
  const d = NativeCalendarDecisionSchema.parse(raw);
  await tx`insert into allrice_native_calendar_decisions
    (decision_id,period_id,kind,outcome,revision,occurrence_id,automation_run_id,successor_period_id,decision,decision_digest,decided_at)
    values(${d.decisionId},${d.periodId},${d.kind},${d.outcome},${d.revision},${d.receiptOccurrenceId},${d.automationRunId},
      ${d.successorPeriodId},${json(tx, d)},${calendarDecisionDigest(d)},${d.decidedAt}::timestamptz)`;
}
async function prepareRetirements(tx: Tx, controlId?: string) {
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

/** Called inside the ORIGINAL admin policy transaction, after its existing
 * advisory/jobs/automation/settings locks. No writer or native snapshot changes. */
export async function syncExperienceNativePolicyInTransaction(
  tx: Tx,
  automationId: string,
) {
  const [rule] = await tx<
    Rule[]
  >`select * from allrice_automations where id=${automationId} for update`;
  if (
    !rule ||
    rule.clock_owner !== 'native_recurring' ||
    !rule.experience_binding
  )
    return false;
  const [parent] = await tx<{ snapshot: { control: unknown } }[]>`
    select snapshot from allrice_native_recurring_controls where automation_id=${rule.id} for update`;
  requireCalendar(parent, 'control_missing');
  const c = NativeCalendarControlSchema.parse(parent.snapshot.control);
  const policy = await readExperiencePolicy(rule.organization_id, tx),
    now = await instant(tx);
  const v = versionFor(rule, policy, now);
  await tx`insert into allrice_native_recurring_versions(automation_id,revision,configuration)
    values(${rule.id},${v.revision},${json(tx, v)})`;
  const next =
    rule.status === 'enabled' && !rule.deleted_at && policy.frequency !== 'off'
      ? nextScheduleAt(v.schedule, now)
      : null;
  await tx`update allrice_automations set native_recurring_revision=${v.revision},native_recurring_request_digest=${v.reservationDigest},
    native_recurring_resume_after=${now},next_run_at=${next} where id=${rule.id}`;
  const plans = await tx<
    { period_id: string }[]
  >`select period_id from allrice_native_calendar_plans
    where control_id=${c.controlId} and closed_decision_id is null order by period_id for update`;
  for (const p of plans)
    await insertDecision(tx, {
      decisionId: randomUUID(),
      periodId: p.period_id,
      kind: 'policy',
      outcome: 'canceled',
      revision: v.revision,
      decidedAt: now.toISOString(),
      receiptOccurrenceId: null,
      automationRunId: null,
      successorPeriodId: null,
      lease: null,
      budget: null,
    });
  await tx`update allrice_native_recurring_occurrences set outbox_state='blocked',outbox_reason='configuration_changed'
    where control_id=${c.controlId} and calendar_period_id is not null and outbox_state='pending'`;
  if (next)
    await insertPlan(
      tx,
      planFor(c, v, next, now, {
        kind: 'policy',
        policyRevision: policy.revision,
      }),
    );
  await prepareRetirements(tx, c.controlId);
  return true;
}

/** Ownership migration is bounded by legacy ownership, never by due time. The
 * exact original P survives downtime. All birth/native prepare/clock writes use
 * one primary transaction and the supplied actual live writer. */
export async function materializeExperienceNativeCalendar(
  calendar: CalendarSql,
  writer: NativeOnceWriter,
  reference: NativeOnceReference,
  allowHandoff = true,
) {
  return calendar.withTransaction(async (tx) => {
    // Retirement is valid after policy off too; a flag is never a clock fallback.
    if (await prepareRetirements(tx)) return true;
    if (!experienceNativeCalendarEnabled()) return false;
    const [pending] = await tx<
      {
        control_id: string;
        snapshot: { control: unknown };
        snapshot_version: number;
        plan: NativeCalendarPlan;
        plan_digest: string;
      }[]
    >`
      select c.control_id,c.snapshot,c.snapshot_version,p.plan,p.plan_digest from allrice_native_calendar_plans p
      join allrice_native_recurring_controls c on c.control_id=p.control_id and c.partition_id=p.partition_id
      where p.closed_decision_id is null and not exists(select 1 from allrice_native_calendar_periods np where np.period_id=p.period_id)
      order by p.created_at,p.period_id limit 1`;
    if (pending) {
      const c = NativeCalendarControlSchema.parse(pending.snapshot.control),
        plan = NativeCalendarPlanSchema.parse(pending.plan);
      const gate = await lockBusiness(tx, c, 'native');
      if (!gate.admission.allowed || gate.admission.status !== 'enabled') {
        await tx`update allrice_automations set status='paused',next_run_at=null where id=${c.automationId}`;
        await insertDecision(tx, {
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
        return true;
      }
      if (c.revision < plan.revision) {
        if (c.sessionState !== 'ready') return false;
        const mutation = {
          kind: 'calendar' as const,
          action: 'apply_revision' as const,
          controlId: c.controlId,
          expectedControlVersion: Number(pending.snapshot_version),
          revision: plan.revision,
          planId: plan.periodId,
          planDigest: pending.plan_digest,
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
    if (!allowHandoff) return false;
    const [candidate] = await tx<Rule[]>`select a.* from allrice_automations a
      join allrice_users u on u.id=a.owner_id and u.status='active'
      join allrice_organizations o on o.id=a.organization_id and o.archived_at is null
      join allrice_workspaces w on w.id=a.workspace_id and w.organization_id=o.id and w.archived_at is null
      join allrice_employee_assignments x on x.id=a.employee_assignment_id and x.user_id=a.owner_id and x.active
      join allrice_employees e on e.id=x.employee_id and e.status='active'
      join allrice_employee_instances i on i.id=(a.experience_binding->>'instanceId')::uuid and i.assignment_id=x.id
        and i.organization_id=a.organization_id and i.workspace_id=a.workspace_id and i.owner_id=a.owner_id and i.archived_at is null
      left join allrice_settings company on company.scope_type='organization' and company.scope_id=a.organization_id and company.key='employee_experience_policy'
      left join allrice_settings defaults on defaults.scope_type='system' and defaults.scope_id is null and defaults.key='employee_experience_policy'
      where a.experience_binding is not null and a.clock_owner='legacy' and a.deleted_at is null and a.status='enabled'
        and coalesce(company.value,defaults.value)->>'frequency'<>'off'
        and a.experience_binding->>'policyDigest'=allrice_native_control_document_digest(coalesce(company.value,defaults.value))
        and exists(select 1 from allrice_memberships m where m.organization_id=a.organization_id and m.user_id=a.owner_id
          and m.active and m.role in ('member','admin') and (m.workspace_id is null or m.workspace_id=a.workspace_id))
        and not exists(select 1 from allrice_platform_employee_tenant_assignments t where t.organization_id=x.organization_id
          and t.workspace_id=x.workspace_id and t.tenant_employee_id=x.employee_id and not t.active)
      order by a.created_at,a.id limit 1`;
    if (!candidate) return false;
    const binding = ExperienceAutomationBindingSchema.parse(
      candidate.experience_binding,
    );
    const c = NativeCalendarControlSchema.parse({
      kind: 'calendar',
      binding: 'rotating-at-v1',
      partitionId: PARTITION,
      controlId: randomUUID(),
      organizationId: candidate.organization_id,
      workspaceId: candidate.workspace_id,
      ownerId: candidate.owner_id,
      automationId: candidate.id,
      revision: Number(candidate.revision),
      controlSessionId: `calendar-${randomUUID()}`,
      reference,
      sessionState: 'reserved',
      nativeTaskId: null,
      dispatch: {
        consumer: CONSUMER,
        employeeAssignmentId: candidate.employee_assignment_id,
        employeeInstanceId: binding.instanceId,
      },
    });
    const gate = await lockBusiness(tx, c, 'initialize');
    if (
      !gate.rule ||
      !gate.admission.allowed ||
      gate.admission.status !== 'enabled'
    )
      return false;
    const now = await instant(tx),
      v = versionFor(gate.rule, gate.policy, now);
    await calendar.initializeControlInTransaction(tx, {
      control: c,
      revision: v,
    });
    const P = gate.rule.next_run_at ?? nextScheduleAt(v.schedule, now);
    const plan = planFor(c, v, P, now, { kind: 'handoff' });
    await tx`update allrice_automations set clock_owner='native_recurring',native_recurring_request_id=id,
      native_recurring_request_digest=${v.reservationDigest},native_recurring_revision=${v.revision},
      native_recurring_resume_after=${new Date(P.getTime() - 1)},next_run_at=${P} where id=${c.automationId} and clock_owner='legacy'`;
    await insertPlan(tx, plan);
    await calendar.prepareCalendarPeriodInTransaction(tx, writer, {
      controlId: c.controlId,
      expectedRevision: v.revision,
      periodId: plan.periodId,
      armId: plan.initialArmId,
      businessScheduledFor: plan.businessScheduledFor,
      nativeAt: plan.businessScheduledFor,
      reason: 'business_target',
      planId: plan.periodId,
    });
    return true;
  });
}

export type ExperienceCalendarOccurrence = {
  occurrence_id: string;
  partition_id: string;
  control_id: string;
  automation_id: string;
  revision: number | string;
  payload: unknown;
  payload_digest: string;
  outbox_owner_id: string | null;
  outbox_epoch: number | string;
  outbox_token_digest: string | null;
  outbox_state: string;
  calendar_period_id?: string | null;
  calendar_arm_id?: string | null;
};

/** A retained native receipt authorizes one original experience reservation,
 * not a new queue/Run engine. N is committed regardless of later model outcome. */
export async function dispatchExperienceCalendarNative(
  tx: Tx,
  c: NativeCalendarControl,
  claimed: ExperienceCalendarOccurrence,
  workerId: string,
  tokenDigest: string,
) {
  const gate = await lockBusiness(tx, c, 'native');
  requireCalendar(gate.rule, 'business_missing');
  await tx`select 1 from allrice_native_once_partitions where partition_id=${PARTITION} for update`;
  await tx`select 1 from allrice_native_recurring_controls where control_id=${c.controlId} and partition_id=${PARTITION} for update`;
  const [native] = await tx<
    {
      period: NativeCalendarPeriod;
      arm: NativeCalendarArm;
      plan: NativeCalendarPlan;
      decision_id: string | null;
    }[]
  >`
    select allrice_native_calendar_period_json(p) period,allrice_native_calendar_arm_json(a) arm,b.plan,p.business_decision_id decision_id
    from allrice_native_calendar_periods p join allrice_native_calendar_arms a on a.arm_id=p.current_arm_id and a.period_id=p.period_id
    join allrice_native_calendar_plans b on b.period_id=p.plan_id
    where p.period_id=${claimed.calendar_period_id ?? null} and p.control_id=${c.controlId} and p.partition_id=${PARTITION}
    for update of p,a,b`;
  const [live] = await tx<
    ExperienceCalendarOccurrence[]
  >`select * from allrice_native_recurring_occurrences
    where occurrence_id=${claimed.occurrence_id} for update`;
  requireCalendar(
    native &&
      live &&
      live.outbox_owner_id === workerId &&
      Number(live.outbox_epoch) === Number(claimed.outbox_epoch) &&
      live.outbox_token_digest === tokenDigest &&
      live.payload_digest === claimed.payload_digest &&
      isDeepStrictEqual(live.payload, claimed.payload) &&
      nativeOnceDigest(live.payload) === live.payload_digest,
    'lease_lost',
  );
  if (native.decision_id) {
    if (live.outbox_state !== 'enqueued')
      await tx`update allrice_native_recurring_occurrences set outbox_state='blocked',
      outbox_reason='receipt_for_terminal_period' where occurrence_id=${live.occurrence_id}`;
    return;
  }
  const pp = native.period,
    aa = native.arm,
    plan = NativeCalendarPlanSchema.parse(native.plan);
  const [version] = await tx<
    { configuration: NativeCalendarRevision }[]
  >`select configuration from allrice_native_recurring_versions
    where automation_id=${c.automationId} and revision=${pp.revision}`;
  requireCalendar(version, 'revision_missing');
  const v = NativeCalendarRevisionSchema.parse(version.configuration);
  const task = aa.taskSnapshot as {
    lastDelivery?: unknown;
    deliveryHistory?: { records: unknown[] };
  };
  const expected = {
    control: calendarControlIdentity(c),
    revision: v,
    calendar: {
      period: calendarPeriodIdentity(pp),
      arm: calendarArmIdentity(aa),
    },
    businessScheduledFor: pp.businessScheduledFor,
    nativeTaskId: aa.nativeTaskId,
    receipt: task.deliveryHistory?.records[0] ?? task.lastDelivery,
  };
  const identity = calendarOccurrenceIdentity(
    c.automationId,
    pp.periodId,
    pp.businessScheduledFor,
  );
  requireCalendar(
    pp.state === 'received' &&
      aa.status === 'received' &&
      live.occurrence_id === identity.id &&
      pp.periodId === plan.periodId &&
      pp.revision === v.revision &&
      live.calendar_arm_id === aa.armId &&
      isDeepStrictEqual(expected, live.payload),
    'receipt_changed',
  );
  const [lease] =
    await tx`select 1 from allrice_native_recurring_occurrences where occurrence_id=${live.occurrence_id}
    and outbox_expires_at>clock_timestamp()`;
  requireCalendar(lease, 'lease_lost');
  const now = await instant(tx),
    reason =
      live.outbox_state === 'blocked'
        ? 'native_receipt_already_blocked'
        : calendarAdmissionReason(pp, v, gate.admission);
  const result = reason
    ? { outcome: 'policy_blocked' as const }
    : await reserveExperienceOccurrenceInTransaction(
        tx,
        gate.rule,
        new Date(pp.businessScheduledFor),
        live.occurrence_id,
      );
  const advances = result.outcome !== 'policy_blocked';
  const successor = advances
    ? planFor(c, v, nextScheduleAt(v.schedule, now), now, {
        kind: 'successor',
        predecessorPeriodId: pp.periodId,
      })
    : null;
  const d = NativeCalendarDecisionSchema.parse({
    decisionId: randomUUID(),
    periodId: pp.periodId,
    kind: 'receipt',
    outcome:
      result.outcome === 'policy_blocked'
        ? 'authority_blocked'
        : result.outcome,
    revision: pp.revision,
    decidedAt: now.toISOString(),
    receiptOccurrenceId: live.occurrence_id,
    automationRunId:
      'automationRunId' in result ? result.automationRunId : null,
    successorPeriodId: successor?.periodId ?? null,
    lease: { ownerId: workerId, epoch: Number(live.outbox_epoch), tokenDigest },
    budget: result.outcome === 'budget' ? result.budget : null,
  });
  if (!advances)
    await tx`update allrice_automations set status='paused',next_run_at=null where id=${c.automationId}`;
  await insertDecision(tx, d);
  if (successor) {
    await tx`update allrice_automations set next_run_at=${successor.businessScheduledFor}::timestamptz,
      last_run_at=clock_timestamp(),updated_at=clock_timestamp() where id=${c.automationId}`;
    await insertPlan(tx, successor);
  }
  if (d.automationRunId) {
    const [run] = await tx<
      { experience_occurrence: unknown }[]
    >`select experience_occurrence from allrice_automation_runs where id=${d.automationRunId}`;
    requireCalendar(run, 'business_run_missing');
    const binding = {
      consumer: CONSUMER,
      periodId: pp.periodId,
      decisionId: d.decisionId,
      automationRunId: d.automationRunId,
      payloadDigest: live.payload_digest,
      outcome: d.outcome,
      origin: run.experience_occurrence,
    };
    await tx`update allrice_native_recurring_occurrences set outbox_state='enqueued',outbox_reason=null,
      business_binding=${json(tx, binding)} where occurrence_id=${live.occurrence_id}`;
  } else
    await tx`update allrice_native_recurring_occurrences set outbox_state='blocked',
    outbox_reason=${result.outcome === 'budget' ? 'EXPERIENCE_DAILY_BUDGET' : (reason ?? 'experience_policy_changed')}
    where occurrence_id=${live.occurrence_id}`;
  await prepareRetirements(tx, c.controlId);
}
