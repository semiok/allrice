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
  async function persistence() {
    return db.begin('isolation level repeatable read read only', async (tx) => {
      const rows = await loadNativeRecurringPartitionRows(tx, reference, true);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.kind).sort(), [
        'calendar',
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
      a.arm_id,a.native_at,a.native_task_id,a.task_snapshot,d.outcome,d.automation_run_id,d.successor_period_id,
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
  async function closed(epoch) {
    assert.equal(runtime.status().state, 'closed');
    assert.equal(runtime.status().faultCount, 0);
    assert.equal(runtime.status().controller.stats.adapterCalls, 0);
    assert.equal((await partition()).closed, true);
    const [p] =
      await db`select proof from allrice_native_once_close_proofs where partition_id='allrice-recurring-v1' and epoch=${epoch}`;
    assert.equal(p.proof.kind, 'public_host_backend_drained');
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
  const complete = await waitFor(
    cycle,
    (p) => p.outcome === 'empty' && p.next_task_id && p.retirement_id,
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
  const [empty] =
    await db`select * from allrice_automation_runs where id=${complete.automation_run_id}`;
  assert.equal(empty.status, 'succeeded');
  assert.equal(empty.run_id, null);
  assert.equal(empty.error_code, 'EXPERIENCE_NO_NEW_EVIDENCE');
  assert.equal(empty.scheduled_for.toISOString(), input.P);
  assert.equal(
    (
      await db`select id from allrice_jobs where payload->>'type'='allrice.experience.consolidate'`
    ).length,
    0,
  );
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
      lockAdmission: database.lockExperienceCalendarAdmissions,
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
  assert.equal(Number(running.epoch), epoch);
  assert.equal(running.owner_id, writer.owner_id);
  // The SDK control path persists Sessions to JSONL, without registering them
  // in workspace.sessionIds. Preserve the entire actual workspace/journal,
  // and prove Session durability through its real public persistence reader.
  const durable = await persistence();
  const sessions = durable.controls.map((c) => c.controlSessionId);
  assert.ok(sessions.includes(fixedBirth.control_session_id));
  assert.ok(sessions.includes(calendar.control_session_id));
  await runtime.stop();
  const firstClose = await closed(epoch),
    firstStats = runtime.status().controller.stats;
  assert.deepEqual(await persistence(), durable);
  const firstHistoryCount = await verifyNativeOnceControlHistory(
    reference,
    durable.controls,
  );
  assert.equal(firstHistoryCount, 2);
  if (interrupted) throw Error('actual_calendar_host_interrupted');
  runtime = open();
  if (interrupted) throw Error('actual_calendar_host_interrupted_before_tick');
  await runtime.tick();
  assert.equal(runtime.status().state, 'active');
  assert.equal(runtime.status().faultCount, 0);
  const resumed = await partition(),
    resumedCycle = await cycle();
  assert.deepEqual(await persistence(), durable);
  assert.equal(Number(resumed.epoch), epoch + 1);
  assert.equal(resumedCycle.native_task_id, complete.native_task_id);
  assert.equal(resumedCycle.next_task_id, complete.next_task_id);
  const [fixedResumed] =
    await db`select native_task_id from allrice_native_recurring_controls where automation_id=${input.fixedId}`;
  assert.equal(fixedResumed.native_task_id, fixedBirth.native_task_id);
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
  const secondClose = await closed(epoch + 1);
  assert.deepEqual(await persistence(), durable);
  const coldHistoryCount = await verifyNativeOnceControlHistory(
    reference,
    durable.controls,
  );
  assert.equal(coldHistoryCount, 2);
  process.stdout.write(
    `NATIVE_CALENDAR_HOST_EVIDENCE ${JSON.stringify({
      artifactId: reference.artifactId,
      pid: process.pid,
      startedAt,
      profileId: reference.profileId,
      models: 0,
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
      coldEpoch: Number(resumed.epoch),
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
