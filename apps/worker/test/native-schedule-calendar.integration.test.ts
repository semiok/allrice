import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { authorizeFixturePlatformAdministrator } from '../../../packages/database/src/platform-authority.fixture.ts';
import { seedExperienceCalendarRule } from '../../../packages/database/src/experience-native.fixture.ts';
import { readExperiencePolicy, updateExperiencePolicy } from '../../../packages/database/src/experience-consolidation.ts';
import { createChatSession } from '../../../packages/database/src/workspace/service.ts';
import { createRecurringTask, initializeNativeRecurringPartition, lockNativeRecurringAdmissions } from '../../../packages/database/src/native-schedule-recurring-product.ts';
import { createNativeRecurringSqlStore } from '../../../packages/database/src/native-schedule-recurring-sql.ts';
import { lockExperienceCalendarAdmissions } from '../../../packages/database/src/experience-native.ts';
import { nativeOnceDigest } from '../../../packages/database/src/native-schedule-once-state.ts';
import * as client from '../../../packages/database/src/core/client.ts';
import { createNativeOnceControlSource, parseNativeScheduleControlReference } from '../src/native-schedule-once-loader.ts';
import { createNativeOnceWorkerRuntime } from '../src/native-schedule-once-runtime.ts';

// Deliberately separate from pure/SQL suites: only root's isolated actual-Host
// window may enable this. There is no fake Task, receipt, clock or Host facade.
const suite = process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  process.env.ALLRICE_RUN_NATIVE_CALENDAR_HOST === '1' ? describe.sequential : describe.skip;
suite('production mixed public Host calendar cycle, actual clock and zero model calls', () => {
  let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
  let runtime: ReturnType<typeof createNativeOnceWorkerRuntime> | undefined;
  let source: ReturnType<typeof createNativeOnceControlSource>;
  let seeded: Awaited<ReturnType<typeof seedExperienceCalendarRule>>;
  let fixedId: string;
  beforeAll(async () => {
    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
    vi.stubEnv('ALLRICE_NATIVE_CALENDAR_ENABLED', '1');
    vi.stubEnv('ALLRICE_EXPERIENCE_REVIEW_ENABLED', '1');
    const reference = parseNativeScheduleControlReference(JSON.parse(process.env.ALLRICE_NATIVE_RECURRING_REFERENCE ?? 'null'));
    expect(reference.profileId).toBe('allrice-recurring-control-v1');
    // Root supplies a dedicated empty state directory. Never erase/reuse an
    // existing control history or borrow another session's persistent storage.
    expect(await readdir(reference.stateRoot)).toEqual([]);
    source = createNativeOnceControlSource(reference);
    f = await createP27CodexWorkerFixture({ allowCiDatabase: true, personalProfile: 'writable' });
    vi.spyOn(client, 'getDatabase').mockReturnValue(f.db);
    await authorizeFixturePlatformAdministrator(f.db, f.ownerId);
    const previous = await readExperiencePolicy(f.organizationId);
    await updateExperiencePolicy(f.context, f.organizationId, {
      frequency: 'monthly', timezone: 'America/New_York', time: '02:30', weekday: 1, monthDay: 31,
      expectedRevision: previous.revision, validationMode: 'off', adoptionMode: 'off',
    });
    seeded = await seedExperienceCalendarRule(f, 'empty');
    await initializeNativeRecurringPartition(reference);
    const chat = await createChatSession(f.context, {
      workspaceId: f.workspaceId, employeeAssignmentId: f.assignmentId, title: 'Isolated fixed coexistence',
    });
    const fixed = await createRecurringTask(f.context, chat.id, {
      clientRequestId: randomUUID(), name: 'Fixed real public clock witness',
      prompt: 'Only record this isolated scheduled receipt. No model is executed by this acceptance.',
      rule: { kind: 'every', seconds: 60 },
    });
    fixedId = fixed.id;
  }, 120_000);
  afterAll(async () => {
    // A failed public shutdown must retain the fixture for root investigation,
    // rather than dropping SQL while an unconfirmed Host could still write.
    await runtime?.stop();
    if (runtime) expect(runtime.status().state).toBe('closed');
    try { await f?.close(); } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
  }, 30_000);
  const open = () => createNativeOnceWorkerRuntime({
    enabled: true, workerId: randomUUID(), reference: source.reference,
    loadModules: () => source.loadModules(), loadHostFactory: () => source.loadHostFactory(),
  });
  async function partition() {
    const [p] = await f.db`select * from allrice_native_once_partitions where partition_id='allrice-recurring-v1'`;
    if (!p) throw Error('actual_host_partition_missing');
    return p;
  }
  async function cycle() {
    const [p] = await f.db`select p.period_id,p.business_scheduled_for,p.current_arm_id,
      a.arm_id,a.native_at,a.native_task_id,a.task_snapshot,a.absence_proof,
      d.decision_id,d.outcome,d.automation_run_id,d.successor_period_id,
      successor.business_scheduled_for next_p,next_arm.native_task_id next_task_id,
      retirement.retirement_id
      from allrice_native_calendar_periods p
      join allrice_native_calendar_arms a on a.arm_id=p.current_arm_id and a.period_id=p.period_id
      left join allrice_native_calendar_decisions d on d.period_id=p.period_id
      left join allrice_native_calendar_periods successor on successor.period_id=d.successor_period_id
      left join allrice_native_calendar_arms next_arm on next_arm.arm_id=successor.current_arm_id and next_arm.period_id=successor.period_id
      left join allrice_native_calendar_retirements retirement on retirement.arm_id=a.arm_id
      where p.automation_id=${seeded.automationId} and p.business_scheduled_for=${seeded.P}`;
    return p;
  }
  async function waitFor<T>(read: () => Promise<T | undefined>, ready: (value: T) => boolean, milliseconds: number) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      await runtime!.tick();
      const value = await read();
      if (value && ready(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw Error(`actual_calendar_host_timeout:${JSON.stringify(runtime!.status())}`);
  }
  async function assertClosed(epoch: number) {
    expect(runtime!.status()).toMatchObject({ state: 'closed', faultCount: 0 });
    expect(runtime!.status().controller!.stats.adapterCalls).toBe(0);
    const p = await partition();
    expect(p.closed).toBe(true);
    const [proof] = await f.db`select proof from allrice_native_once_close_proofs
      where partition_id='allrice-recurring-v1' and epoch=${epoch}`;
    expect(proof!.proof.kind).toBe('public_host_backend_drained');
    for (const key of ['publicHostCloseCompletedAt', 'scheduleBackendDrainCompletedAt',
      'auxiliaryBackendDrainCompletedAt', 'backendDrainCompletedAt', 'controllerReleaseBoundaryAt'])
      expect(Number.isFinite(Date.parse(proof!.proof.evidence[key]))).toBe(true);
    return proof!.proof;
  }
  it('recovers overdue P using the real mixed document, delivers, decides/N, retires, keeps fixed running and reopens cold', async () => {
    runtime = open();
    await runtime.tick();
    expect(runtime.status()).toMatchObject({ state: 'active', faultCount: 0 });
    const firstWriter = await partition(), epoch = Number(firstWriter.epoch);
    const [fixedBirth] = await f.db`select * from allrice_native_recurring_controls where automation_id=${fixedId}`;
    expect(fixedBirth!.native_task_id).toBeTruthy();
    const [calendar] = await f.db`select * from allrice_native_recurring_controls where automation_id=${seeded.automationId}`;
    const initial = await cycle();
    expect(initial!.business_scheduled_for.toISOString()).toBe(seeded.P.toISOString());
    expect(initial!.native_at > seeded.P).toBe(true);
    const [absent] = await f.db`select a.absence_proof from allrice_native_calendar_arms a
      join allrice_native_calendar_periods p on p.period_id=a.period_id
      where p.period_id=${initial!.period_id} and a.attempt=1`;
    expect(absent!.absence_proof).toEqual({
      kind: 'never_started', taskSetDigest: nativeOnceDigest({ [fixedBirth!.native_task_id]: fixedBirth!.snapshot.task }),
    });
    // Actual createOnce at the driver's short future A. Never fabricate a
    // native receipt or advance the native/public clock to the monthly N.
    const complete = await waitFor(cycle, (p) => p.outcome === 'empty' && !!p.next_task_id && !!p.retirement_id, 30_000);
    expect(complete.native_task_id).not.toBe(complete.next_task_id);
    expect(complete.task_snapshot.status).toBe('inactive');
    expect(complete.task_snapshot.deliveryHistory.records).toHaveLength(1);
    expect(complete.task_snapshot.lastDelivery.scheduledAt).toBe(complete.native_at.toISOString());
    expect(complete.task_snapshot.lastDelivery.messageId).toBeTruthy();
    const [emptyRun] = await f.db`select * from allrice_automation_runs where id=${complete.automation_run_id}`;
    expect(emptyRun).toMatchObject({ status: 'succeeded', run_id: null, error_code: 'EXPERIENCE_NO_NEW_EVIDENCE' });
    expect(emptyRun!.scheduled_for.toISOString()).toBe(seeded.P.toISOString());
    expect(await f.db`select id from allrice_jobs where payload->>'type'='allrice.experience.consolidate'`).toHaveLength(0);
    const loaded = await source.loadModules();
    // Readback-only observer: no acquire/renew/release or public Host. The sole
    // production runtime owns both fixed/calendar lifecycle and workspace.
    const observer = createNativeRecurringSqlStore({
      db: f.db, partitionId: 'allrice-recurring-v1', ownerId: 'read-only-host-evidence', reference: source.reference,
      readiness: () => ({ enabled: true, storageReady: true, legacyClockExcluded: true, controlArtifactApproved: true }),
      decodeTask: (value) => loaded.schedule.scheduleDomain.tables.tasks.valueSchema.parse(value),
      lockAdmission: lockNativeRecurringAdmissions,
      calendar: { enabled: true, lockAdmission: lockExperienceCalendarAdmissions }, proveClosed: async () => null,
    });
    const [arm] = await f.db`select request_digest from allrice_native_calendar_arms where arm_id=${complete.arm_id}`;
    expect((await observer.calendar!.readExactCalendarArm(complete.arm_id, arm!.request_digest)).state).toBe('bound');
    expect(await observer.calendar!.readExactCalendarRetirement(complete.retirement_id)).toBe('committed');
    const fixedRun = await waitFor(async () => {
      const [r] = await f.db`select r.id,r.run_id,j.id job_id from allrice_automation_runs r
        join allrice_jobs j on j.run_id=r.run_id where r.automation_id=${fixedId}`;
      return r;
    }, (r) => !!r.job_id, 80_000);
    const [fixedNow] = await f.db`select * from allrice_native_recurring_controls where automation_id=${fixedId}`;
    expect(fixedNow!.native_task_id).toBe(fixedBirth!.native_task_id);
    expect(fixedNow!.snapshot.task.deliveryHistory.records).toHaveLength(1);
    expect(Date.parse(fixedNow!.snapshot.task.record.scheduledAt)).toBeGreaterThan(Date.parse(fixedBirth!.snapshot.task.record.scheduledAt));
    const running = await partition();
    expect(Number(running.epoch)).toBe(epoch);
    expect(running.owner_id).toBe(firstWriter.owner_id);
    const sessions = Object.values(running.workspace_snapshot.tables.workspaces as Record<string, { sessionIds: string[] }>).flatMap((w) => w.sessionIds);
    expect(sessions).toContain(fixedBirth!.control_session_id);
    expect(sessions).toContain(calendar!.control_session_id);
    await runtime.stop();
    const firstClose = await assertClosed(epoch), firstStats = runtime.status().controller!.stats;
    runtime = open();
    await runtime.tick();
    expect(runtime.status()).toMatchObject({ state: 'active', faultCount: 0 });
    const resumed = await partition();
    expect(Number(resumed.epoch)).toBe(epoch + 1);
    const resumedCycle = await cycle();
    expect(resumedCycle!.native_task_id).toBe(complete.native_task_id);
    expect(resumedCycle!.next_task_id).toBe(complete.next_task_id);
    const [fixedResumed] = await f.db`select native_task_id from allrice_native_recurring_controls where automation_id=${fixedId}`;
    expect(fixedResumed!.native_task_id).toBe(fixedBirth!.native_task_id);
    expect(await f.db`select decision_id from allrice_native_calendar_decisions where period_id=${complete.period_id}`).toHaveLength(1);
    expect(await observer.calendar!.readExactCalendarRetirement(complete.retirement_id)).toBe('committed');
    await runtime.stop();
    const secondClose = await assertClosed(epoch + 1);
    process.stdout.write(`NATIVE_CALENDAR_HOST_EVIDENCE ${JSON.stringify({
      artifactId: source.reference.artifactId, profileId: source.reference.profileId,
      P: seeded.P.toISOString(), A: complete.native_at.toISOString(), N: complete.next_p.toISOString(),
      periodId: complete.period_id, armId: complete.arm_id,
      controlSessionId: calendar!.control_session_id, retiredTaskId: complete.native_task_id, nextTaskId: complete.next_task_id,
      fixedTaskId: fixedBirth!.native_task_id, fixedRunId: fixedRun.run_id,
      firstEpoch: epoch, coldEpoch: Number(resumed.epoch), firstStats, coldStats: runtime.status().controller!.stats,
      firstClose, secondClose,
    })}\n`);
  }, 150_000);
});
