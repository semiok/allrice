// Isolated root-only carrier: actual built production code, clock and approved
// public Host. No fake Task/receipt, test ports or production configuration edit.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import * as database from '@allrice/database';
import { loadNativeRecurringPartitionRows } from '../../../packages/database/dist/native-schedule-recurring-loader.js';
import { lockNativeOnceJobAdmission } from '../../../packages/database/dist/native-schedule-once-authority.js';
import {
  nativeOnceWorkspaceDigest,
  validateNativeOnceWorkspaceSnapshot,
} from '../../../packages/database/dist/native-schedule-workspace-state.js';
import {
  createNativeOnceControlSource,
  parseNativeScheduleControlReference,
  verifyNativeOnceControlHistory,
} from '../dist/native-schedule-once-loader.js';
import { createNativeOnceWorkerRuntime } from '../dist/native-schedule-once-runtime.js';
import { installDshNativeArtifact } from '../dist/harness/dsh-native-artifact.js';

let runtime,
  interrupted = false;
const startedAt = new Date().toISOString();
const stop = () => {
  interrupted = true;
  void runtime
    ?.stop()
    .catch((error) => process.stderr.write(`${error.stack ?? error}\n`));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
async function main() {
  assert.equal(process.env.ALLRICE_RUN_DB_INTEGRATION, '1');
  assert.equal(process.env.ALLRICE_RUN_NATIVE_CALENDAR_HOST, '1');
  assert.ok(
    process.env.ALLRICE_TEST_DATABASE_URL ===
      'postgres://a123@127.0.0.1:5432/allrice_b2',
    'actual Host requires the exact local fixture authorization',
  );
  process.stdout.write(
    `NATIVE_CALENDAR_HOST_CHILD_START ${JSON.stringify({ pid: process.pid, startedAt })}\n`,
  );
  const input = JSON.parse(process.argv[2] ?? 'null');
  const consumer = input.consumer ?? 'experience-consolidation-v1';
  assert.ok(
    ['experience-consolidation-v1', 'ordinary-monthly-v1'].includes(consumer),
  );
  const ordinary = consumer === 'ordinary-monthly-v1';
  if (ordinary) assert.equal(process.env.ALLRICE_RUN_NATIVE_MONTHLY_HOST, '1');
  const url = new URL(process.env.DATABASE_URL),
    authorized = new URL(process.env.ALLRICE_TEST_DATABASE_URL);
  assert.equal(url.pathname, '/allrice_b2');
  assert.equal(url.host, authorized.host);
  assert.equal(url.username, authorized.username);
  assert.ok(
    url.password === authorized.password,
    'isolated fixture credential identity changed',
  );
  assert.match(input.schema, /^p25_[a-f0-9]{32}$/);
  assert.equal(
    url.searchParams.get('options'),
    `-csearch_path=${input.schema},public`,
  );
  const reference = parseNativeScheduleControlReference(
    JSON.parse(process.env.ALLRICE_NATIVE_RECURRING_REFERENCE ?? 'null'),
  );
  assert.equal(reference.profileId, 'allrice-recurring-control-v1');
  const root = process.env.ALLRICE_NATIVE_CALENDAR_HOST_ARTIFACT_ROOT,
    expectedId = process.env.ALLRICE_DSH_NATIVE_ARTIFACT_ID;
  assert.ok(root && isAbsolute(root) && expectedId);
  assert.equal(reference.artifactId, expectedId);
  assert.equal((await readdir(reference.stateRoot)).length, 0);
  const db = database.getDatabase();
  const [scope] =
    await db`select current_schema() schema,current_database() database`;
  assert.equal(scope.schema, input.schema);
  assert.equal(scope.database, 'allrice_b2');
  process.stdout.write(
    `NATIVE_CALENDAR_HOST_CHILD_SCOPE ${JSON.stringify({ pid: process.pid, schema: scope.schema, database: scope.database })}\n`,
  );
  // The same measured verifier/registry as production startup. Approval is
  // supplied independently by root, never inferred from a manifest's claim.
  await installDshNativeArtifact({ root, expectedId });
  const source = createNativeOnceControlSource(reference);
  const open = () =>
    createNativeOnceWorkerRuntime({
      enabled: true,
      workerId: randomUUID(),
      reference,
      loadModules: () => source.loadModules(),
      loadHostFactory: () => source.loadHostFactory(),
    });
  const P = new Date(input.P);
  async function partition() {
    const [p] =
      await db`select * from allrice_native_once_partitions where partition_id='allrice-recurring-v1'`;
    assert.ok(p);
    return p;
  }
  async function persistence(expectedControls = ordinary ? 3 : 2) {
    return db.begin('isolation level repeatable read read only', async (tx) => {
      const rows = await loadNativeRecurringPartitionRows(tx, reference, true);
      assert.equal(rows.length, expectedControls);
      assert.deepEqual(rows.map((r) => r.kind).sort(), [
        ...Array(expectedControls - 1).fill('calendar'),
        'recurring',
      ]);
      const controls = rows.map(({ kind, snapshot: { control: c } }) => ({
        kind,
        controlId: c.controlId,
        automationId: c.automationId,
        controlSessionId: c.controlSessionId,
        sessionState: c.sessionState,
        nativeTaskId: c.nativeTaskId,
      }));
      assert.ok(controls.every((c) => c.sessionState === 'ready'));
      const [p] =
        await tx`select workspace_snapshot from allrice_native_once_partitions where partition_id='allrice-recurring-v1'`;
      const [journal] = await tx`select * from allrice_native_once_journal
          where partition_id='allrice-recurring-v1' and entry_kind='workspace'
          order by (after_snapshot->>'revision')::bigint desc limit 1`;
      validateNativeOnceWorkspaceSnapshot(p.workspace_snapshot, {
        stateRoot: reference.stateRoot,
        controlSessionIds: new Set(controls.map((c) => c.controlSessionId)),
      });
      assert.ok(p.workspace_snapshot.revision > 0);
      assert.equal(p.workspace_snapshot.global.initialized, true);
      assert.deepEqual(journal.reference, reference);
      assert.deepEqual(journal.after_snapshot, p.workspace_snapshot);
      assert.equal(
        journal.after_digest,
        nativeOnceWorkspaceDigest(p.workspace_snapshot),
      );
      assert.equal(journal.journal.afterDigest, journal.after_digest);
      assert.equal(
        journal.journal.afterRevision,
        p.workspace_snapshot.revision,
      );
      return { controls, workspace: p.workspace_snapshot, journal };
    });
  }
  async function cycle() {
    const [p] =
      await db`select p.period_id,p.business_scheduled_for,p.current_arm_id,
      a.arm_id,a.native_at,a.native_task_id,a.task_snapshot,d.outcome,d.decided_at,d.automation_run_id,d.successor_period_id,
      successor.business_scheduled_for next_p,next_arm.native_task_id next_task_id,retirement.retirement_id
      from allrice_native_calendar_periods p
      join allrice_native_calendar_arms a on a.arm_id=p.current_arm_id and a.period_id=p.period_id
      left join allrice_native_calendar_decisions d on d.period_id=p.period_id
      left join allrice_native_calendar_periods successor on successor.period_id=d.successor_period_id
      left join allrice_native_calendar_arms next_arm on next_arm.arm_id=successor.current_arm_id and next_arm.period_id=successor.period_id
      left join allrice_native_calendar_retirements retirement on retirement.arm_id=a.arm_id
      where p.automation_id=${input.automationId} and p.business_scheduled_for=${P}`;
    return p;
  }
  async function waitFor(read, ready, milliseconds) {
    const until = Date.now() + milliseconds;
    while (Date.now() < until && !interrupted) {
      await runtime.tick();
      const value = await read();
      if (value && ready(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw Error(
      `actual_calendar_host_timeout:${JSON.stringify(runtime.status())}`,
    );
  }
  async function drained(epoch) {
    const [p] =
      await db`select proof from allrice_native_once_close_proofs where partition_id='allrice-recurring-v1' and epoch=${epoch}`;
    assert.equal(p.proof.kind, 'public_host_backend_drained');
    assert.equal(p.proof.partitionId, 'allrice-recurring-v1');
    assert.equal(p.proof.epoch, epoch);
    assert.equal(
      p.proof.evidence.referenceDigest,
      database.nativeOnceDigest(reference),
    );
    for (const key of [
      'publicHostCloseCompletedAt',
      'scheduleBackendDrainCompletedAt',
      'auxiliaryBackendDrainCompletedAt',
      'backendDrainCompletedAt',
      'controllerReleaseBoundaryAt',
    ])
      assert.ok(Number.isFinite(Date.parse(p.proof.evidence[key])));
    return p.proof;
  }
  async function closed(epoch) {
    assert.equal(runtime.status().state, 'closed');
    assert.equal(runtime.status().faultCount, 0);
    assert.equal(runtime.status().controller.stats.adapterCalls, 0);
    assert.equal((await partition()).closed, true);
    return drained(epoch);
  }
  if (interrupted) throw Error('actual_calendar_host_interrupted_before_open');
  runtime = open();
  if (interrupted) throw Error('actual_calendar_host_interrupted_before_tick');
  await runtime.tick();
  assert.equal(runtime.status().state, 'active');
  assert.equal(runtime.status().faultCount, 0);
  const writer = await partition(),
    epoch = Number(writer.epoch);
  const [fixedBirth] =
    await db`select * from allrice_native_recurring_controls where automation_id=${input.fixedId}`;
  const [calendar] =
    await db`select * from allrice_native_recurring_controls where automation_id=${input.automationId}`;
  assert.equal(calendar.immutable_identity.dispatch.consumer, consumer);
  assert.ok(fixedBirth.native_task_id);
  const initial = await cycle();
  assert.equal(initial.business_scheduled_for.toISOString(), input.P);
  assert.ok(initial.native_at > P);
  const [absent] =
    await db`select a.absence_proof from allrice_native_calendar_arms a
    join allrice_native_calendar_periods p on p.period_id=a.period_id where p.period_id=${initial.period_id} and a.attempt=1`;
  assert.deepEqual(absent.absence_proof, {
    kind: 'never_started',
    taskSetDigest: database.nativeOnceDigest({
      [fixedBirth.native_task_id]: fixedBirth.snapshot.task,
    }),
  });
  let runningEpoch = epoch,
    liveAddition;
  if (ordinary) {
    // The first two actual Sessions and native Tasks already exist. Enrollment
    // below is a real public business write while this same runtime is active.
    assert.ok(initial.native_task_id);
    const before = await persistence(2),
      initialHistoryCount = await verifyNativeOnceControlHistory(
        reference,
        before.controls,
      );
    assert.equal(initialHistoryCount, 2);
    const enrollment = input.lateEnrollment,
      identity = calendar.immutable_identity;
    assert.equal(enrollment.context.actor.type, 'user');
    assert.equal(enrollment.context.actor.id, identity.ownerId);
    assert.equal(enrollment.context.organizationId, identity.organizationId);
    assert.equal(enrollment.context.workspaceId, identity.workspaceId);
    assert.equal(
      enrollment.employeeAssignmentId,
      identity.dispatch.employeeAssignmentId,
    );
    if (interrupted) throw Error('actual_calendar_host_interrupted');
    const createdAt = new Date().toISOString(),
      chat = await database.createChatSession(enrollment.context, {
        workspaceId: identity.workspaceId,
        employeeAssignmentId: enrollment.employeeAssignmentId,
        employeeInstanceId: identity.dispatch.employeeInstanceId,
        title: 'Added while the real shared Host is active',
      }),
      target = new Date(
        Math.ceil((Date.now() + 14 * 86_400_000) / 1000) * 1000,
      ),
      rule = {
        kind: 'monthly',
        monthDay: target.getUTCDate(),
        time: target.toISOString().slice(11, 19),
        timezone: 'UTC',
      },
      requestId = randomUUID(),
      added = await database.createRecurringTask(enrollment.context, chat.id, {
        clientRequestId: requestId,
        name: 'Far future monthly live Session enrollment',
        prompt: '十四天后的普通月任务；本次验收不执行这项业务。',
        rule,
      });
    assert.equal(added.status, 'preparing');
    assert.notEqual(added.id, input.automationId);
    assert.notEqual(added.id, input.fixedId);
    const [reserved] = await db`select c.control_session_id,c.snapshot,
        a.next_run_at,(select count(*)::int from allrice_native_calendar_periods p
          where p.automation_id=a.id) periods
      from allrice_native_recurring_controls c join allrice_automations a on a.id=c.automation_id
      where a.id=${added.id}`;
    assert.equal(reserved.snapshot.control.sessionState, 'reserved');
    assert.equal(reserved.periods, 0);
    assert.equal(reserved.next_run_at.toISOString(), target.toISOString());
    assert.ok(target.getTime() > Date.now() + 7 * 86_400_000);
    assert.ok(
      before.controls.every(
        (c) => c.controlSessionId !== reserved.control_session_id,
      ),
    );
    assert.equal(runtime.status().state, 'active');
    assert.equal(Number((await partition()).epoch), epoch);
    // No stop()/open() here: production refresh must drain its old generation.
    await runtime.tick();
    assert.equal(runtime.status().state, 'cold');
    assert.equal(runtime.status().faultCount, 0);
    assert.equal(runtime.status().controller.fault, undefined);
    const released = await partition();
    assert.equal(Number(released.epoch), epoch);
    assert.equal(released.closed, true);
    const refreshClose = await drained(epoch);
    assert.equal(refreshClose.ownerId, writer.owner_id);
    assert.equal(refreshClose.tokenDigest, writer.token_digest);
    const rebound = await waitFor(
      async () => {
        const [r] = await db`select c.control_session_id,c.snapshot,
            np.period_id,arm.arm_id,arm.request_digest,arm.native_at,arm.native_task_id,arm.task_snapshot
          from allrice_native_recurring_controls c
          join allrice_native_calendar_plans b on b.control_id=c.control_id and b.closed_decision_id is null
          join allrice_native_calendar_periods np on np.plan_id=b.period_id
          join allrice_native_calendar_arms arm on arm.arm_id=np.current_arm_id and arm.period_id=np.period_id
          where c.automation_id=${added.id}`;
        return r;
      },
      (r) =>
        runtime.status().state === 'active' &&
        r.snapshot.control.sessionState === 'ready' &&
        r.native_task_id,
      30_000,
    );
    const reopened = await partition();
    runningEpoch = Number(reopened.epoch);
    assert.equal(runningEpoch, epoch + 1);
    assert.equal(reopened.owner_id, writer.owner_id);
    assert.notEqual(reopened.token_digest, writer.token_digest);
    assert.equal(runtime.status().faultCount, 0);
    assert.equal(runtime.status().controller.fault, undefined);
    assert.equal(runtime.status().controller.stats.adapterCalls, 0);
    assert.equal(rebound.control_session_id, reserved.control_session_id);
    assert.equal(rebound.native_at.toISOString(), target.toISOString());
    assert.equal(rebound.task_snapshot.sessionId, reserved.control_session_id);
    assert.equal(rebound.task_snapshot.record.id, rebound.native_task_id);
    assert.equal(rebound.task_snapshot.record.kind, 'at');
    assert.equal(rebound.task_snapshot.status, 'active');
    const after = await persistence(),
      historyCount = await verifyNativeOnceControlHistory(
        reference,
        after.controls,
      );
    assert.equal(historyCount, 3); // public JSONL stat/header, no UI registry claim
    assert.deepEqual(
      after.controls.map((c) => c.controlSessionId).sort(),
      [
        ...before.controls.map((c) => c.controlSessionId),
        reserved.control_session_id,
      ].sort(),
    );
    const projection = await database.getRecurringTask(
      enrollment.context,
      chat.id,
      added.id,
    );
    assert.equal(projection.task.status, 'enabled');
    assert.equal(projection.task.nextRunAt, target.toISOString());
    assert.deepEqual(projection.task.rule, rule);
    liveAddition = {
      pid: process.pid,
      createdAt,
      requestId,
      automationId: added.id,
      sessionId: chat.id,
      controlSessionId: rebound.control_session_id,
      P: target.toISOString(),
      periodId: rebound.period_id,
      armId: rebound.arm_id,
      requestDigest: rebound.request_digest,
      nativeTaskId: rebound.native_task_id,
      task: rebound.task_snapshot,
      originalEpoch: epoch,
      reopenedEpoch: runningEpoch,
      initialHistoryCount,
      historyCount,
      before,
      after,
      refreshClose,
    };
  }
  const complete = await waitFor(
    cycle,
    (p) =>
      p.outcome === (ordinary ? 'queued' : 'empty') &&
      p.next_task_id &&
      p.retirement_id,
    30_000,
  );
  assert.notEqual(complete.native_task_id, complete.next_task_id);
  assert.equal(complete.task_snapshot.status, 'inactive');
  assert.equal(complete.task_snapshot.deliveryHistory.records.length, 1);
  assert.equal(
    complete.task_snapshot.lastDelivery.scheduledAt,
    complete.native_at.toISOString(),
  );
  assert.ok(complete.task_snapshot.lastDelivery.messageId);
  const [business] =
    await db`select * from allrice_automation_runs where id=${complete.automation_run_id}`;
  assert.equal(business.scheduled_for.toISOString(), input.P);
  let ordinaryJobId;
  if (ordinary) {
    assert.equal(business.status, 'queued');
    assert.ok(business.run_id);
    assert.equal(business.manual_request_id, null);
    assert.equal(business.folder_event_id, null);
    const [job] =
      await db`select id from allrice_jobs where run_id=${business.run_id}`;
    ordinaryJobId = job.id;
    assert.deepEqual(
      await db.begin((tx) => lockNativeOnceJobAdmission(tx, job.id)),
      { scheduled: true, allowed: true, runId: business.run_id },
    );
    const workerId = randomUUID(),
      claimed = await database.claimNextJob(workerId, 120000);
    assert.equal(claimed.id, job.id);
    assert.ok(
      await database.startClaimedJob(workerId, claimed.id, claimed.lease.token),
    );
    const [current] =
      await db`select a.prompt,er.prompt_snapshot from allrice_automations a
      join allrice_employee_runs er on er.run_id=${business.run_id} where a.id=${input.automationId}`;
    assert.ok(current.prompt_snapshot.userRequest.endsWith(current.prompt));
    const [next] =
      await db`select allrice_ordinary_monthly_next(v.configuration->'rule',${complete.decided_at}) target
      from allrice_native_recurring_versions v where v.automation_id=${input.automationId} and v.revision=1`;
    assert.equal(complete.next_p.toISOString(), next.target.toISOString());
    await database.failJob({
      workerId,
      jobId: claimed.id,
      leaseToken: claimed.lease.token,
      code: 'HOST_FIXTURE_NO_MODEL',
      message: 'Original admission/preparation proved; provider not invoked',
      retryable: false,
    });
  } else {
    assert.equal(business.status, 'succeeded');
    assert.equal(business.run_id, null);
    assert.equal(business.error_code, 'EXPERIENCE_NO_NEW_EVIDENCE');
    assert.equal(
      (
        await db`select id from allrice_jobs where payload->>'type'='allrice.experience.consolidate'`
      ).length,
      0,
    );
  }
  const modules = await source.loadModules();
  // Readback only: never acquire/renew/release another writer or open a Host.
  const observer = database.createNativeRecurringSqlStore({
    db,
    partitionId: 'allrice-recurring-v1',
    ownerId: 'read-only-host-evidence',
    reference,
    readiness: () => ({
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    }),
    decodeTask: (value) =>
      modules.schedule.scheduleDomain.tables.tasks.valueSchema.parse(value),
    lockAdmission: database.lockNativeRecurringAdmissions,
    calendar: {
      enabled: true,
      lockAdmission: database.lockNativeCalendarAdmissions,
    },
    proveClosed: async () => null,
  });
  const [arm] =
    await db`select request_digest from allrice_native_calendar_arms where arm_id=${complete.arm_id}`;
  assert.equal(
    (
      await observer.calendar.readExactCalendarArm(
        complete.arm_id,
        arm.request_digest,
      )
    ).state,
    'bound',
  );
  assert.equal(
    await observer.calendar.readExactCalendarRetirement(complete.retirement_id),
    'committed',
  );
  if (liveAddition) {
    const exact = await observer.calendar.readExactCalendarArm(
      liveAddition.armId,
      liveAddition.requestDigest,
    );
    assert.equal(exact.state, 'bound');
    assert.equal(exact.arm.nativeTaskId, liveAddition.nativeTaskId);
    assert.deepEqual(exact.fullTask, liveAddition.task);
  }
  const fixedRun = await waitFor(
    async () => {
      const [r] =
        await db`select r.id,r.run_id,j.id job_id from allrice_automation_runs r join allrice_jobs j on j.run_id=r.run_id where r.automation_id=${input.fixedId}`;
      return r;
    },
    (r) => r.job_id,
    80_000,
  );
  const [fixedNow] =
    await db`select * from allrice_native_recurring_controls where automation_id=${input.fixedId}`;
  assert.equal(fixedNow.native_task_id, fixedBirth.native_task_id);
  assert.equal(fixedNow.snapshot.task.deliveryHistory.records.length, 1);
  assert.ok(
    Date.parse(fixedNow.snapshot.task.record.scheduledAt) >
      Date.parse(fixedBirth.snapshot.task.record.scheduledAt),
  );
  const running = await partition();
  assert.equal(Number(running.epoch), runningEpoch);
  assert.equal(running.owner_id, writer.owner_id);
  async function unusedLateBusiness() {
    if (!liveAddition) return;
    assert.equal(
      (
        await db`select id from allrice_automation_runs where automation_id=${liveAddition.automationId}`
      ).length,
      0,
    );
    assert.equal(
      (
        await db`select run_id from allrice_employee_runs where session_id=${liveAddition.sessionId}`
      ).length,
      0,
    );
  }
  await unusedLateBusiness();
  // The SDK control path persists Sessions to JSONL, without registering them
  // in workspace.sessionIds. Preserve the entire actual workspace/journal,
  // and prove Session durability through its real public persistence reader.
  const durable = await persistence();
  const sessions = durable.controls.map((c) => c.controlSessionId);
  assert.ok(sessions.includes(fixedBirth.control_session_id));
  assert.ok(sessions.includes(calendar.control_session_id));
  if (liveAddition) assert.ok(sessions.includes(liveAddition.controlSessionId));
  await runtime.stop();
  const firstClose = await closed(runningEpoch),
    firstStats = runtime.status().controller.stats;
  assert.deepEqual(await persistence(), durable);
  const firstHistoryCount = await verifyNativeOnceControlHistory(
    reference,
    durable.controls,
  );
  assert.equal(firstHistoryCount, ordinary ? 3 : 2);
  if (interrupted) throw Error('actual_calendar_host_interrupted');
  runtime = open();
  if (interrupted) throw Error('actual_calendar_host_interrupted_before_tick');
  await runtime.tick();
  assert.equal(runtime.status().state, 'active');
  assert.equal(runtime.status().faultCount, 0);
  const resumed = await partition(),
    resumedCycle = await cycle();
  assert.deepEqual(await persistence(), durable);
  assert.equal(Number(resumed.epoch), runningEpoch + 1);
  assert.equal(resumedCycle.native_task_id, complete.native_task_id);
  assert.equal(resumedCycle.next_task_id, complete.next_task_id);
  const [fixedResumed] =
    await db`select native_task_id from allrice_native_recurring_controls where automation_id=${input.fixedId}`;
  assert.equal(fixedResumed.native_task_id, fixedBirth.native_task_id);
  if (liveAddition) {
    const exact = await observer.calendar.readExactCalendarArm(
      liveAddition.armId,
      liveAddition.requestDigest,
    );
    assert.equal(exact.state, 'bound');
    assert.equal(exact.arm.nativeTaskId, liveAddition.nativeTaskId);
    assert.deepEqual(exact.fullTask, liveAddition.task);
    await unusedLateBusiness();
  }
  assert.equal(
    (
      await db`select decision_id from allrice_native_calendar_decisions where period_id=${complete.period_id}`
    ).length,
    1,
  );
  assert.equal(
    await observer.calendar.readExactCalendarRetirement(complete.retirement_id),
    'committed',
  );
  await runtime.stop();
  const secondClose = await closed(runningEpoch + 1);
  assert.deepEqual(await persistence(), durable);
  const coldHistoryCount = await verifyNativeOnceControlHistory(
    reference,
    durable.controls,
  );
  assert.equal(coldHistoryCount, ordinary ? 3 : 2);
  process.stdout.write(
    `NATIVE_CALENDAR_HOST_EVIDENCE ${JSON.stringify({
      artifactId: reference.artifactId,
      pid: process.pid,
      startedAt,
      profileId: reference.profileId,
      models: 0,
      consumer,
      businessRunId: business.run_id,
      ordinaryJobId,
      P: input.P,
      A: complete.native_at.toISOString(),
      N: complete.next_p.toISOString(),
      periodId: complete.period_id,
      armId: complete.arm_id,
      controlSessionId: calendar.control_session_id,
      retiredTaskId: complete.native_task_id,
      nextTaskId: complete.next_task_id,
      fixedTaskId: fixedBirth.native_task_id,
      fixedRunId: fixedRun.run_id,
      firstEpoch: epoch,
      runningEpoch,
      coldEpoch: Number(resumed.epoch),
      liveAddition,
      firstStats,
      coldStats: runtime.status().controller.stats,
      firstHistoryCount,
      coldHistoryCount,
      durable,
      firstClose,
      secondClose,
    })}\n`,
  );
}
try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error.stack ?? error}\n${JSON.stringify(runtime?.status() ?? { state: 'not_started' })}\n`,
  );
  process.exitCode = 1;
} finally {
  try {
    await runtime?.stop();
    process.stdout.write(
      `NATIVE_CALENDAR_HOST_CHILD_STOP ${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), runtimeState: runtime?.status().state ?? 'not_started' })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
  await database.closeDatabase();
}
