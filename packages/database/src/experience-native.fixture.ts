/** Isolated SQL/Host acceptance setup. No provider request or native Task write. */
import { randomUUID } from 'node:crypto';
import { experiencePolicySchedule } from '@allrice/contracts';
import type { P27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { prepareEmployeeInstanceSnapshot } from './employees/employee-instances.ts';
import { seedHistoricalExperienceSource } from './experience-history.fixture.ts';
import { readExperiencePolicy } from './experience-consolidation.ts';

import { runtimePolicyDigest } from './runtime-policy.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import { lockNativeRecurringAdmissions } from './native-schedule-recurring-product.ts';
import { lockExperienceCalendarAdmissions } from './experience-native.ts';
import {
  NativeCalendarControlSchema,
  NativeCalendarRevisionSchema,
  type NativeCalendarWrite,
} from './native-schedule-calendar-state.ts';
import {
  calendarPlanFor,
  insertCalendarPlanInTransaction,
} from './native-schedule-calendar-business.ts';
import {
  nativeOnceDigest,
  type NativeOnceReference,
  type NativeOnceTask,
} from './native-schedule-once-state.ts';

/** Build an explicit pre-retirement native receipt in disposable SQL only.
 * The synthetic historical gate ends before returning; all test actions use
 * the real retired-consumer gate. No product switch, Host or model is used. */
export async function seedHistoricalExperienceCalendar(
  f: P27CodexWorkerFixture,
  automationId: string,
  reference: NativeOnceReference,
) {
  const ready = {
    enabled: true,
    storageReady: true,
    legacyClockExcluded: true,
    controlArtifactApproved: true,
  };
  const [rule] =
    await f.db`select * from allrice_automations where id=${automationId}`;
  if (!/^p25_[a-f0-9]{32}$/.test(f.schema) || !rule?.experience_binding)
    throw Error('historical_calendar_requires_isolated_fixture');
  const policy = await readExperiencePolicy(f.organizationId);
  const now = new Date();
  const c = NativeCalendarControlSchema.parse({
    kind: 'calendar',
    binding: 'rotating-at-v1',
    partitionId: 'allrice-recurring-v1',
    controlId: randomUUID(),
    organizationId: f.organizationId,
    workspaceId: f.workspaceId,
    ownerId: f.ownerId,
    automationId,
    revision: Number(rule.revision),
    controlSessionId: `calendar-${randomUUID()}`,
    reference,
    sessionState: 'reserved',
    nativeTaskId: null,
    dispatch: {
      consumer: 'experience-consolidation-v1',
      employeeAssignmentId: f.assignmentId,
      employeeInstanceId: rule.experience_binding.instanceId,
    },
  });
  const reservation = {
    consumer: 'experience-consolidation-v1',
    automationId,
    revision: c.revision,
    schedule: rule.schedule,
    organizationId: f.organizationId,
    workspaceId: f.workspaceId,
    ownerId: f.ownerId,
    employeeAssignmentId: f.assignmentId,
    employeeInstanceId: rule.experience_binding.instanceId,
    policyRevision: policy.revision,
    policyDigest: runtimePolicyDigest(policy),
  };
  const v = NativeCalendarRevisionSchema.parse({
    kind: 'calendar',
    binding: 'rotating-at-v1',
    consumer: 'experience-consolidation-v1',
    revision: c.revision,
    ruleRevision: c.revision,
    schedule: rule.schedule,
    policyRevision: policy.revision,
    policyDigest: runtimePolicyDigest(policy),
    reservationDigest: nativeOnceDigest(reservation),
    acceptedAt: now.toISOString(),
  });
  await f.db`insert into allrice_native_once_partitions(partition_id,reference,activation)
    values('allrice-recurring-v1',${f.db.json({ ...reference })},${f.db.json(ready)})`;
  let historical = true;
  const store = createNativeRecurringSqlStore({
    db: f.db,
    partitionId: 'allrice-recurring-v1',
    ownerId: randomUUID(),
    reference,
    ttlMs: 300000,
    readiness: () => ready,
    decodeTask: (value) => structuredClone(value) as NativeOnceTask,
    lockAdmission: lockNativeRecurringAdmissions,
    calendar: {
      enabled: true,
      lockAdmission: async (tx, controls, purpose) => {
        if (!historical)
          return lockExperienceCalendarAdmissions(tx, controls, purpose);
        if (controls.some((control) => control.controlId !== c.controlId))
          throw Error('historical_fixture_scope');
        return new Map(
          controls.map((control) => [
            control.controlId,
            {
              allowed: true,
              currentRevision: v.revision,
              policyRevision: policy.revision,
              policyDigest: runtimePolicyDigest(policy),
              status: 'enabled' as const,
              resumeAfter: null,
            },
          ]),
        );
      },
    },
    proveClosed: async () => null,
  });
  const writer = (await store.acquireWriter())!.writer,
    calendar = store.calendar!;
  const plan = calendarPlanFor(c, v, rule.next_run_at, now, {
    kind: 'handoff',
  });
  let current = await f.db.begin(async (tx) => {
    await calendar.initializeControlInTransaction(tx, {
      control: c,
      revision: v,
    });
    await tx`update allrice_automations set clock_owner='native_recurring',native_recurring_request_id=id,
      native_recurring_request_digest=${v.reservationDigest},native_recurring_revision=${v.revision},
      native_recurring_resume_after=${new Date(rule.next_run_at.getTime() - 1)} where id=${automationId}`;
    await insertCalendarPlanInTransaction(tx, plan);
    return calendar.prepareCalendarPeriodInTransaction(tx, writer, {
      controlId: c.controlId,
      expectedRevision: v.revision,
      periodId: plan.periodId,
      armId: plan.initialArmId,
      businessScheduledFor: plan.businessScheduledFor,
      nativeAt: plan.businessScheduledFor,
      reason: 'business_target',
      planId: plan.periodId,
    });
  });
  const write = (
    mutation: NativeCalendarWrite['mutation'],
  ): NativeCalendarWrite => ({
    writeId: randomUUID(),
    digest: nativeOnceDigest(mutation),
    mutation,
  });
  for (const [action, version] of [
    ['session_initializing', 0],
    ['session_ready', 1],
  ] as const)
    await store.commitMutation(
      writer,
      write({
        kind: 'calendar',
        action,
        controlId: c.controlId,
        expectedControlVersion: version,
      }),
    );
  const absent = await calendar.confirmCalendarArmAbsent(writer, {
    periodId: current.period.periodId,
    armId: current.arm.armId,
    requestDigest: current.arm.requestDigest,
    expectedPeriodVersion: current.period.version,
    expectedArmVersion: current.arm.snapshotVersion,
    taskRecords: await store.loadTaskRecords(writer),
  });
  current = await calendar.prepareCalendarArm(writer, {
    periodId: absent.period.periodId,
    previousArmId: absent.arm.armId,
    expectedPeriodVersion: absent.period.version,
    expectedArmVersion: absent.arm.snapshotVersion,
    armId: randomUUID(),
    nativeAt: new Date(Date.now() + 60000).toISOString(),
  });
  current = await calendar.beginCalendarArmCreate(writer, {
    periodId: current.period.periodId,
    armId: current.arm.armId,
    requestDigest: current.arm.requestDigest,
    expectedPeriodVersion: current.period.version,
    expectedArmVersion: current.arm.snapshotVersion,
  });
  let task: NativeOnceTask = {
    sessionId: c.controlSessionId,
    status: 'active',
    record: {
      id: randomUUID(),
      kind: 'at',
      scheduledAt: current.arm.nativeAt,
      title: 'AllRice once control',
      prompt: 'Synthetic schedule control only. Never execute business work.',
    },
  };
  async function put() {
    const w = write({
      kind: 'calendar',
      action: 'put_task',
      controlId: c.controlId,
      periodId: current.period.periodId,
      armId: current.arm.armId,
      requestDigest: current.arm.requestDigest,
      expectedPeriodVersion: current.period.version,
      expectedArmVersion: current.arm.snapshotVersion,
      task,
    });
    if ((await store.commitMutation(writer, w)) !== 'committed')
      throw Error('historical_fixture_commit_failed');
    const exact = await calendar.readExactCalendarArm(
      current.arm.armId,
      current.arm.requestDigest,
    );
    if (exact.state !== 'bound') throw Error('historical_fixture_not_bound');
    current = { period: exact.period, arm: exact.arm };
    return w;
  }
  await put();
  const delivery = {
    scheduledAt: current.arm.nativeAt,
    deliveredAt: new Date(
      Date.parse(current.arm.nativeAt) + 1000,
    ).toISOString(),
    messageId: randomUUID(),
  };
  task = {
    ...task,
    status: 'inactive',
    lastDelivery: delivery,
    deliveryHistory: {
      records: [{ ...delivery, prompt: task.record.prompt }],
      earlierRecordsUnavailable: false,
    },
  };
  const receiptWrite = await put();
  historical = false;
  return {
    store,
    writer,
    control: c,
    revision: v,
    period: current.period,
    arm: current.arm,
    receiptWrite,
  };
}

export async function captureCalendarFixtureSource(
  f: P27CodexWorkerFixture,
  instanceId: string,
) {
  // Completed synthetic history is evidence input, not a current admission.
  // Preserve its instance and NULL origin rather than inventing an executor
  // approval or binding for the historical result inserted below.
  const session = { id: randomUUID() };
  await f.db`insert into allrice_chat_sessions
    (id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_instance_id,employee_version_id,title)
    values(${session.id},${f.organizationId},${f.workspaceId},${f.ownerId},${f.assignmentId},${instanceId},${f.employeeVersionId},
      'Isolated incremental calendar evidence')`;
  const instance = await prepareEmployeeInstanceSnapshot(
    f.context,
    session.id,
    f.assignmentId,
    f.employeeVersionId,
  );
  const runId = randomUUID(),
    messageId = randomUUID(),
    assistantId = randomUUID();
  const text = '刚才的对账报告漏了退款，核对时需要单列退款再汇总净回款。🍚';
  await f.db`insert into allrice_messages(id,organization_id,workspace_id,owner_id,session_id,role,content,status)
    values(${messageId},${f.organizationId},${f.workspaceId},${f.ownerId},${session.id},'user',${f.db.json({ text, citations: [] })},'completed'),
    (${assistantId},${f.organizationId},${f.workspaceId},${f.ownerId},${session.id},'assistant','{"text":"SQL fixture completed; no provider call"}','completed')`;
  await f.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input)
    values(${runId},${f.organizationId},${f.workspaceId},${f.ownerId},'succeeded','{}','{}')`;
  await f.db`insert into allrice_employee_runs(run_id,organization_id,workspace_id,owner_id,employee_assignment_id,employee_version_id,
    session_id,user_message_id,assistant_message_id,status,completed_at,provider_snapshot,prompt_snapshot,execution_snapshot,experience_capture_state)
    values(${runId},${f.organizationId},${f.workspaceId},${f.ownerId},${f.assignmentId},${f.employeeVersionId},${session.id},${messageId},${assistantId},
      'succeeded',clock_timestamp(),'{}','{}',${f.db.json({ instance, personalSkills: { skills: [] } })},'pending')`;
  await seedHistoricalExperienceSource(f.db, runId);
  const [source] = await f.db<
    { memory_id: string }[]
  >`select memory_id from allrice_experience_reviews
    where run_id=${runId} and origin_kind='incremental' and status='pending' and consolidation_occurrence_id is null`;
  if (!source) throw Error('calendar_fixture_incremental_source_missing');
  return {
    id: source.memory_id,
    runId,
    messageId,
    sessionId: session.id,
    text,
  };
}

export async function seedExperienceCalendarRule(
  f: P27CodexWorkerFixture,
  mode: 'empty' | 'queued',
) {
  const policy = await readExperiencePolicy(f.organizationId);
  if (policy.frequency === 'off') throw Error('calendar_fixture_policy_off');
  const schedule = experiencePolicySchedule(policy);
  const [instance] = await f.db<
    { id: string }[]
  >`select id from allrice_employee_instances
    where assignment_id=${f.assignmentId} and owner_id=${f.ownerId} and archived_at is null`;
  if (!instance) throw Error('calendar_fixture_instance_missing');
  const source =
    mode === 'empty'
      ? null
      : await captureCalendarFixtureSource(f, instance.id);
  const automationId = randomUUID(),
    P = new Date(Date.now() - 90 * 86_400_000);
  await f.db`insert into allrice_automations(id,organization_id,workspace_id,owner_id,name,prompt,trigger_type,schedule,status,
    conversation_mode,employee_assignment_id,next_run_at,experience_binding)
    values(${automationId},${f.organizationId},${f.workspaceId},${f.ownerId},'Isolated original experience calendar',
      'Only use already captured private evidence','schedule',${f.db.json(schedule)},'enabled','new_each_run',${f.assignmentId},${P},
      ${f.db.json({ schemaVersion: 1, instanceId: instance.id, policyDigest: runtimePolicyDigest(policy) })})`;
  const [saved] = await f.db<
    { next_run_at: Date }[]
  >`select next_run_at from allrice_automations where id=${automationId}`;
  if (!saved || saved.next_run_at >= new Date())
    throw Error('calendar_fixture_requires_saved_overdue_P');
  return {
    automationId,
    instanceId: instance.id,
    source,
    legacyOccurrenceId: null,
    P: saved.next_run_at,
  };
}
