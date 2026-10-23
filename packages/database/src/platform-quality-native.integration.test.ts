/** Real isolated PostgreSQL only. Receipts are synthetic SQL component inputs;
 * no Host clock, Worker handler, provider, browser, or shared Dev is started. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TransactionSql } from 'postgres';
import type { RequestContext } from '@allrice/contracts';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import * as client from './core/client.ts';
import { createPlatformQualityNativeFixture } from './platform-quality-native.fixture.ts';
import { claimDueAutomations } from './execution/automation.ts';
import {
  authenticateSession,
  createSession,
  revokeSession,
} from './identity.ts';
import {
  cancelPlatformQualityCheck,
  createPlatformQualityCheck,
  getPlatformQualityCheck,
  getPlatformQualityExecution,
} from './platform-quality.ts';
import {
  claimPlatformQualityOccurrence,
  deletePlatformQualitySchedule,
  dispatchPlatformQualityOccurrence,
  getPlatformQualitySchedule,
  qualityOccurrenceRequestId,
  recoverPlatformQualityOccurrences,
  updatePlatformQualitySchedule,
} from './platform-quality-automation.ts';
import {
  assertQualityNativeOccurrence,
  migrateOneLegacyQualitySchedule,
  syncPlatformQualityNative,
} from './platform-quality-native.ts';
import {
  dispatchNextNativeRecurringOccurrence,
  initializeNativeRecurringPartition,
  lockNativeRecurringAdmissions,
} from './native-schedule-recurring-product.ts';
import { createNativeRecurringSqlStore } from './native-schedule-recurring-sql.ts';
import type {
  NativeRecurringMutation,
  NativeRecurringSnapshot,
  NativeRecurringTask,
  NativeRecurringWrite,
} from './native-schedule-recurring-state.ts';
import {
  nativeOnceDigest,
  type NativeOnceReference,
  type NativeOnceWriter,
} from './native-schedule-once-state.ts';
import { lockNativeOnceJobAdmission } from './native-schedule-once-authority.ts';
import { claimNextJob, startClaimedJob } from './execution/queue.ts';
import {
  listAutomations,
  nextScheduleAt,
  runAutomationNow,
} from './execution/automation.ts';
import type { QualityScheduleOrigin } from './platform-quality-contracts.ts';
import { getWorkAutomation, updateWorkAutomation } from './work-automation.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

suite(
  'platform quality native receipt -> original private durable queue (no model)',
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createPlatformQualityNativeFixture>>;
    let company: Awaited<
      ReturnType<typeof createPlatformQualityNativeFixture>
    >['company'];
    let admin: RequestContext, adminEmail: string, root: string;
    let reference: NativeOnceReference;
    let store: ReturnType<typeof createNativeRecurringSqlStore>;
    let writer: NativeOnceWriter;
    const ready = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
    const normalize = <T>(value: T): T => JSON.parse(JSON.stringify(value));

    beforeAll(async () => {
      f = await createPlatformQualityNativeFixture();
      ({ company, admin, adminEmail } = f);

      root = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-quality-recurring-sql-')),
      );
      reference = {
        artifactId: `sha256:${'b'.repeat(64)}`,
        profileId: 'allrice-recurring-control-v1',
        storageId: 'isolated-quality-sql-only',
        stateRoot: root,
      };
      vi.stubEnv(
        'ALLRICE_NATIVE_RECURRING_REFERENCE',
        JSON.stringify(reference),
      );
      expect(await initializeNativeRecurringPartition(reference)).toMatchObject(
        { reference, activation: ready },
      );
      store = createNativeRecurringSqlStore({
        db: f.db,
        partitionId: 'allrice-recurring-v1',
        ownerId: randomUUID(),
        reference,
        ttlMs: 300_000,
        readiness: () => ready,
        decodeTask: (raw) => structuredClone(raw) as NativeRecurringTask,
        lockAdmission: lockNativeRecurringAdmissions,
        proveClosed: async () => null,
      });
      const grant = await store.acquireWriter();
      expect(grant).not.toBeNull();
      writer = grant!.writer;
    }, 120_000);

    afterEach(async () => {
      if (!f || !admin) return;
      vi.mocked(client.getDatabase).mockReturnValue(f.db);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      // Isolated-schema cleanup through the original APIs, leaving all history.
      const context = (await authenticateSession(
        (await createSession(admin.actor.id)).token,
      ))!;
      const view = await getPlatformQualitySchedule(context);
      if (view.schedule)
        await deletePlatformQualitySchedule(context, {
          expectedRevision: view.schedule.revision,
        });
      const checks =
        await f.db`select q.id from allrice_platform_quality_checks q
        join allrice_jobs j on j.id=q.job_id where q.owner_id=${admin.actor.id}
        and j.status in ('queued','claimed','running','waiting_approval')`;
      for (const row of checks)
        await cancelPlatformQualityCheck(context, row.id);
      // Blocked public receipts are retained as failed business history too.
      // Drain only this disposable schema after its current rule is deleted.
      for (let i = 0; i < 40; i++) {
        if (!(await dispatchNextNativeRecurringOccurrence(randomUUID()))) break;
        if (i === 39)
          throw Error('Isolated native quality cleanup did not settle');
      }
    });

    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30_000);

    async function freshSchedule(time = '09:00') {
      const login = await createSession(admin.actor.id);
      const context = (await authenticateSession(login.token))!;
      const current = await getPlatformQualitySchedule(context);
      if (current.schedule)
        await deletePlatformQualitySchedule(context, {
          expectedRevision: current.schedule.revision,
        });
      const view = await updatePlatformQualitySchedule(context, {
        expectedRevision: 0,
        enabled: true,
        time,
      });
      expect(view.schedule).not.toBeNull();
      const [row] =
        await f.db`select organization_id,workspace_id from allrice_automations where id=${view.schedule!.id}`;
      const privateContext = (await authenticateSession(login.token, {
        organizationId: row!.organization_id,
        workspaceId: row!.workspace_id,
      }))!;
      return {
        context: privateContext,
        loginToken: login.token,
        rule: view.schedule!,
      };
    }
    async function snapshot(id: string) {
      const [row] = await f.db<{ snapshot: NativeRecurringSnapshot }[]>`
        select snapshot from allrice_native_recurring_controls where automation_id=${id}`;
      expect(row).toBeDefined();
      return row!.snapshot;
    }
    async function mutate(mutation: NativeRecurringMutation) {
      expect(await store.renewWriter(writer)).not.toBeNull();
      const write: NativeRecurringWrite = {
        writeId: randomUUID(),
        digest: nativeOnceDigest(mutation),
        mutation,
      };
      expect(await store.commitMutation(writer, write)).toBe('committed');
      expect(await store.readExactCommit(writer, write)).toBe('committed');
      return write;
    }
    async function applyCommand(id: string) {
      let s = await snapshot(id);
      const c = s.control;
      if (c.sessionState === 'reserved') {
        await mutate({ kind: 'session_initializing', controlId: c.controlId });
        await mutate({ kind: 'session_ready', controlId: c.controlId });
        s = await snapshot(id);
      }
      expect(c.command.status).toBe('pending');
      expect(c.rule.kind).toBe('daily');
      if (c.rule.kind !== 'daily') throw Error('Expected quality daily rule');
      const [version] =
        await f.db`select configuration from allrice_native_recurring_versions
        where automation_id=${id} and revision=${c.revision}`;
      const initialTarget =
        version!.configuration.legacyScheduledFor ??
        nextScheduleAt({
          frequency: 'daily',
          time: c.rule.time.slice(0, 5),
          timezone: c.rule.timezone,
        }).toISOString();
      const task: NativeRecurringTask = s.task
        ? (structuredClone(s.task) as NativeRecurringTask)
        : {
            sessionId: c.controlSessionId,
            status: 'active',
            record: {
              id: randomUUID(),
              kind: 'daily',
              title: 'AllRice once control',
              prompt:
                'Synthetic schedule control only. Never execute business work.',
              scheduledAt: initialTarget,
            },
          };
      task.record.kind = 'daily';
      task.record.time = `${c.rule.time}.000`;
      task.record.timeZone = c.rule.timezone;
      if (c.command.kind === 'update')
        task.record.scheduledAt = nextScheduleAt({
          frequency: 'daily',
          time: c.rule.time.slice(0, 5),
          timezone: c.rule.timezone,
        }).toISOString();
      await mutate({ kind: 'put_task', controlId: c.controlId, task });
      await mutate({
        kind: 'confirm_command',
        controlId: c.controlId,
        commandId: c.command.id,
        nativeTaskId: task.record.id,
      });
      return snapshot(id);
    }
    async function receipt(id: string) {
      const s = await snapshot(id),
        task = structuredClone(s.task) as NativeRecurringTask;
      expect(task).not.toBeNull();
      const delivery = {
        scheduledAt: task.record.scheduledAt,
        // A synthetic component receipt follows the frozen target, which may be
        // future relative to this test's DB clock. This is not timer acceptance.
        deliveredAt: new Date(
          Math.max(Date.now(), Date.parse(task.record.scheduledAt) + 1),
        ).toISOString(),
        messageId: randomUUID(),
      };
      task.lastDelivery = delivery;
      task.deliveryHistory = {
        records: [
          ...(task.deliveryHistory?.records ?? []),
          { ...delivery, prompt: task.record.prompt },
        ],
        earlierRecordsUnavailable: false,
      };
      task.record.scheduledAt = new Date(
        Date.parse(delivery.scheduledAt) + 86_400_000,
      ).toISOString();
      const write = await mutate({
        kind: 'put_task',
        controlId: s.control.controlId,
        task,
      });
      const rows = await f.db`select * from allrice_native_recurring_occurrences
        where automation_id=${id} and scheduled_at=${delivery.scheduledAt}::timestamptz`;
      expect(rows).toHaveLength(1);
      return { write, native: rows[0]!, delivery };
    }
    async function occurrence(id: string) {
      const [row] = await f.db`select ar.*,q.id check_id,q.frozen,q.job_id
        from allrice_automation_runs ar left join allrice_platform_quality_checks q on q.automation_run_id=ar.id where ar.id=${id}`;
      return row!;
    }
    async function qualityRows(id: string) {
      return f.db`select ar.*,q.id check_id,q.job_id,q.frozen from allrice_automation_runs ar
        left join allrice_platform_quality_checks q on q.automation_run_id=ar.id where ar.automation_id=${id} order by ar.created_at,ar.id`;
    }
    async function counts() {
      const [row] =
        await f.db`select (select count(*)::int from allrice_runs) runs,
        (select count(*)::int from allrice_jobs) jobs,
        (select count(*)::int from allrice_platform_quality_checks) checks,
        (select count(*)::int from allrice_route_decisions) routes,
        (select count(*)::int from allrice_model_usage_ledger) usage`;
      return row!;
    }
    async function unrelatedHistory() {
      return normalize({
        run: await f.db`select * from allrice_runs where id=${company.run}`,
        employeeRun:
          await f.db`select * from allrice_employee_runs where run_id=${company.run}`,
        messages:
          await f.db`select * from allrice_messages where id in (${company.message},${company.assistant}) order by id`,
        memberships:
          await f.db`select * from allrice_memberships where organization_id=${company.org} order by id`,
      });
    }
    // Hooks delay or lose only the isolated real PostgreSQL transaction boundary.
    function interceptTransactions(hooks: {
      beforeCommit?: (tx: TransactionSql) => Promise<void>;
      afterCommit?: () => Promise<void>;
    }) {
      return new Proxy(f.db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (...args: unknown[]) => {
            const forwarded = [...args],
              callback = args.at(-1) as (
                tx: TransactionSql,
              ) => Promise<unknown>;
            forwarded[forwarded.length - 1] = async (tx: TransactionSql) => {
              const result = await callback(tx);
              await hooks.beforeCommit?.(tx);
              return result;
            };
            const result = await Reflect.apply(target.begin, target, forwarded);
            await hooks.afterCommit?.();
            return result;
          };
        },
      });
    }

    it('maps one native receipt into one private original quality occurrence/Run/Job; replay and recovery cannot duplicate it', async () => {
      const { context, loginToken, rule } = await freshSchedule();
      const historical = await unrelatedHistory(),
        before = await counts();
      const [plan] =
        await f.db`select * from allrice_automations where id=${rule.id}`;
      expect(plan).toMatchObject({
        clock_owner: 'native_recurring',
        conversation_mode: 'new_each_run',
        schedule: {
          frequency: 'daily',
          time: '09:00',
          timezone: 'Asia/Shanghai',
        },
      });
      const initial = await snapshot(rule.id);
      expect(initial.control.dispatch).toEqual({
        consumer: 'platform-quality-v1',
      });
      const [version] =
        await f.db`select configuration from allrice_native_recurring_versions where automation_id=${rule.id} and revision=1`;
      expect(version!.configuration).toMatchObject({
        consumer: 'platform-quality-v1',
        qualityConfigurationDigest: expect.stringMatching(
          /^sha256:[a-f0-9]{64}$/,
        ),
      });
      // Sync is part of the original management transaction and is idempotent.
      await f.db.begin((tx) => syncPlatformQualityNative(tx, rule.id));
      expect(await snapshot(rule.id)).toEqual(initial);
      await applyCommand(rule.id);
      const first = await receipt(rule.id);
      const logins = normalize(
        await f.db`select * from allrice_sessions order by id`,
      );
      const dispatched = await Promise.all([
        dispatchNextNativeRecurringOccurrence(randomUUID()),
        dispatchNextNativeRecurringOccurrence(randomUUID()),
      ]);
      expect(dispatched.filter(Boolean)).toHaveLength(1);
      const queued = await qualityRows(rule.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        run_id: null,
        session_id: null,
        status: 'queued',
        native_recurring_occurrence_id: first.native.occurrence_id,
      });
      expect(queued[0]!.scheduled_for.toISOString()).toBe(
        first.delivery.scheduledAt,
      );
      expect(queued[0]!.quality_occurrence.scheduledFor).toBe(
        first.delivery.scheduledAt,
      );
      const [projection] =
        await f.db`select next_run_at from allrice_automations where id=${rule.id}`;
      expect(projection!.next_run_at.toISOString()).not.toBe(
        first.delivery.scheduledAt,
      );
      expect(await counts()).toEqual(before);
      await revokeSession(loginToken);
      const afterRevoke = normalize(
        await f.db`select * from allrice_sessions order by id`,
      );
      expect(afterRevoke).not.toEqual(logins);
      // Native pending ARs are recovered by the automation producer, not by
      // asking the legacy due scanner to execute a non-time queue obligation.
      expect(await claimDueAutomations(1)).toBe(0);
      expect((await occurrence(queued[0]!.id)).run_id).toBeNull();
      expect(await counts()).toEqual(before);
      // Scheduled static execution uses current platform authority, no borrowed
      // browser session and no fabricated login for its correlation context.
      expect(await recoverPlatformQualityOccurrences(1)).toBe(1);
      const row = await occurrence(queued[0]!.id);
      expect(row.run_id).toBeTruthy();
      expect(row.session_id).toBeTruthy();
      expect(row.frozen.scheduleOrigin).toEqual(queued[0]!.quality_occurrence);
      expect(row.frozen.requestId).toBe(qualityOccurrenceRequestId(row.id));
      expect(row.frozen.loginSessionId).toBeUndefined();
      expect(
        normalize(await f.db`select * from allrice_sessions order by id`),
      ).toEqual(afterRevoke);
      expect(await store.commitMutation(writer, first.write)).toBe('committed');
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      expect(await dispatchPlatformQualityOccurrence(row.id)).toBe(false);
      expect(await recoverPlatformQualityOccurrences()).toBe(0);
      expect(await qualityRows(rule.id)).toHaveLength(1);
      const after = await counts();
      expect(after).toEqual({
        ...before,
        runs: before.runs + 1,
        jobs: before.jobs + 1,
        checks: before.checks + 1,
      });
      expect(await unrelatedHistory()).toEqual(historical);
      await expect(
        getPlatformQualityCheck(company.owner, row.check_id),
      ).rejects.toThrow('authorization_denied');
      const [other] =
        await f.db`select email from allrice_users where id=${company.neighbor.actor.id}`;
      vi.stubEnv(
        'ALLRICE_PLATFORM_ADMIN_EMAILS',
        `${adminEmail},${other!.email}`,
      );
      await expect(
        getPlatformQualityCheck(company.neighbor, row.check_id),
      ).rejects.toThrow('not_found');
      expect(
        (await getPlatformQualitySchedule(company.neighbor)).occurrences,
      ).toHaveLength(0);
      vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', adminEmail);
      expect(
        (await listAutomations(context, plan!.workspace_id)).automations.some(
          (a) => a.id === rule.id,
        ),
      ).toBe(false);
      await expect(
        runAutomationNow(context, plan!.workspace_id, rule.id),
      ).rejects.toThrow();
    });

    it('allows the reserved native quality Job even when ordinary cloud automation is disabled', async () => {
      const { context, rule } = await freshSchedule();
      await applyCommand(rule.id);
      await receipt(rule.id);
      await dispatchNextNativeRecurringOccurrence(randomUUID());
      expect(await recoverPlatformQualityOccurrences()).toBe(1);
      const [row] = await qualityRows(rule.id);
      // Fresh private quality workspaces have no enabled ordinary cloud choice.
      // Explicitly persist false to avoid testing an accidental default.
      const preferences = await getWorkAutomation(
        context,
        row!.workspace_id,
        f.db,
      );
      expect(
        await updateWorkAutomation(
          context,
          row!.workspace_id,
          {
            expectedRevision: preferences.revision,
            capability: 'cloud',
            enabled: false,
          },
          f.db,
        ),
      ).toMatchObject({ settings: { cloud: false } });
      expect(
        await f.db.begin((tx) => lockNativeOnceJobAdmission(tx, row!.job_id)),
      ).toMatchObject({ scheduled: true, allowed: true });
      const workerId = randomUUID(),
        job = await claimNextJob(workerId, 30_000);
      expect(job?.id).toBe(row!.job_id);
      expect(job!.maxAttempts).toBe(1);
      await startClaimedJob(workerId, job!.id, job!.lease!.token);
      const execution = await getPlatformQualityExecution({
        workerId,
        jobId: job!.id,
        leaseToken: job!.lease!.token,
        attempt: job!.attempt,
      });
      expect(execution.frozen.scheduleOrigin?.occurrenceId).toBe(row!.id);
    });

    it.each(['pause', 'edit', 'delete'] as const)(
      '%s preserves receipt/history but prevents unbound old work before and after management commit',
      async (action) => {
        const { context, rule } = await freshSchedule();
        await applyCommand(rule.id);
        const original = await receipt(rule.id);
        expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
          true,
        );
        const [queued] = await qualityRows(rule.id);
        expect(queued!.run_id).toBeNull();
        const before = await counts();
        const oldVersion = normalize(
          await f.db`select * from allrice_native_recurring_versions where automation_id=${rule.id} order by revision`,
        );
        if (action === 'delete')
          await deletePlatformQualitySchedule(context, {
            expectedRevision: rule.revision,
          });
        else
          await updatePlatformQualitySchedule(context, {
            expectedRevision: rule.revision,
            enabled: action !== 'pause',
            time: action === 'edit' ? '10:00' : '09:00',
          });
        expect(await dispatchPlatformQualityOccurrence(queued!.id)).toBe(false);
        expect(await recoverPlatformQualityOccurrences()).toBe(0);
        expect((await occurrence(queued!.id)).run_id).toBeNull();
        expect((await occurrence(queued!.id)).status).toBe('failed');
        // Delayed old-task receipt after the management transaction stays evidence,
        // not a second chance to dispatch the old immutable business revision.
        const delayed = await receipt(rule.id);
        expect(delayed.native.outbox_state).toBe('blocked');
        expect(await store.commitMutation(writer, original.write)).toBe(
          'committed',
        );
        // Consuming the blocked receipt records "not executed"; it is not a Run.
        expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
          true,
        );
        expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
          false,
        );
        const skipped =
          await f.db`select status,run_id from allrice_automation_runs
        where native_recurring_occurrence_id=${delayed.native.occurrence_id}`;
        expect(skipped).toHaveLength(1);
        expect(skipped[0]).toMatchObject({ status: 'failed', run_id: null });
        expect(await counts()).toEqual(before);
        expect(
          normalize(
            await f.db`select * from allrice_native_recurring_versions where automation_id=${rule.id} and revision=1`,
          ),
        ).toEqual(oldVersion);
        expect(
          (await getPlatformQualitySchedule(context)).occurrences.some(
            (o) => o.id === queued!.id,
          ),
        ).toBe(true);
      },
    );

    it('an edit keeps Task/Session identities, stores a new immutable version, and only its confirmed receipt can execute', async () => {
      const { context, rule } = await freshSchedule();
      const initial = await applyCommand(rule.id),
        old = normalize(
          await f.db`select * from allrice_native_recurring_versions where automation_id=${rule.id}`,
        );
      await updatePlatformQualitySchedule(context, {
        expectedRevision: rule.revision,
        enabled: true,
        time: '10:00',
      });
      const edited = await applyCommand(rule.id);
      expect(edited.control.controlSessionId).toBe(
        initial.control.controlSessionId,
      );
      expect(edited.control.nativeTaskId).toBe(initial.control.nativeTaskId);
      expect(edited.control.appliedRevision).toBe(2);
      expect(
        normalize(
          await f.db`select * from allrice_native_recurring_versions where automation_id=${rule.id} and revision=1`,
        ),
      ).toEqual(old);
      await receipt(rule.id);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      expect(await recoverPlatformQualityOccurrences()).toBe(1);
      const [row] = await qualityRows(rule.id);
      expect(row!.frozen.scheduleOrigin.revision).toBe(2);
      expect(row!.frozen.scheduleOrigin.automationId).toBe(rule.id);
      expect((await getPlatformQualitySchedule(context)).schedule?.time).toBe(
        '10:00',
      );
    });

    it('a lost native outbox COMMIT acknowledgement has one durable quality queue entry and one eventual Run/Job', async () => {
      const { rule } = await freshSchedule();
      await applyCommand(rule.id);
      await receipt(rule.id);
      let armed = false,
        injected = false;
      const db = interceptTransactions({
        beforeCommit: async (tx) => {
          const [r] =
            await tx`select outbox_state from allrice_native_recurring_occurrences where automation_id=${rule.id}`;
          armed = r?.outbox_state === 'enqueued';
        },
        afterCommit: async () => {
          if (armed && !injected) {
            injected = true;
            throw Error('quality test: lost successful COMMIT acknowledgement');
          }
        },
      });
      vi.mocked(client.getDatabase).mockReturnValue(db);
      try {
        await dispatchNextNativeRecurringOccurrence(randomUUID()).catch(
          () => undefined,
        );
      } finally {
        vi.mocked(client.getDatabase).mockReturnValue(f.db);
      }
      expect(injected).toBe(true);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      expect(await qualityRows(rule.id)).toHaveLength(1);
      expect(await recoverPlatformQualityOccurrences()).toBe(1);
      expect(await recoverPlatformQualityOccurrences()).toBe(0);
      const [row] = await qualityRows(rule.id);
      expect(
        await f.db`select id from allrice_jobs where run_id=${row!.run_id}`,
      ).toHaveLength(1);
    });

    it('the native outbox lease expiring at COMMIT rolls back the quality queue binding, not only a future Run', async () => {
      const { rule } = await freshSchedule();
      await applyCommand(rule.id);
      const r = await receipt(rule.id),
        before = await counts();
      let delayed = false;
      const db = interceptTransactions({
        beforeCommit: async (tx) => {
          const [o] =
            await tx`select * from allrice_native_recurring_occurrences where occurrence_id=${r.native.occurrence_id}`;
          if (o?.outbox_state === 'pending' && o.outbox_owner_id) {
            await tx`update allrice_native_recurring_occurrences set outbox_expires_at=clock_timestamp()+interval '1 second' where occurrence_id=${r.native.occurrence_id}`;
          } else if (o?.outbox_state === 'enqueued') {
            delayed = true;
            await tx`select pg_sleep(1.05)`;
          }
        },
      });
      vi.mocked(client.getDatabase).mockReturnValue(db);
      try {
        await expect(
          dispatchNextNativeRecurringOccurrence(randomUUID()),
        ).rejects.toMatchObject({ code: 'P1921' });
      } finally {
        vi.mocked(client.getDatabase).mockReturnValue(f.db);
      }
      expect(delayed).toBe(true);
      expect(await qualityRows(rule.id)).toHaveLength(0);
      expect(await counts()).toEqual(before);
      const [o] =
        await f.db`select outbox_state,business_binding from allrice_native_recurring_occurrences where occurrence_id=${r.native.occurrence_id}`;
      expect(o).toMatchObject({
        outbox_state: 'pending',
        business_binding: null,
      });
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        true,
      );
      expect(await recoverPlatformQualityOccurrences()).toBe(1);
    });

    it('writer expiry at COMMIT rolls back quality receipt, snapshot and journal atomically', async () => {
      const { rule } = await freshSchedule();
      await applyCommand(rule.id);
      const before = await snapshot(rule.id),
        task = structuredClone(before.task) as NativeRecurringTask;
      const delivery = {
        scheduledAt: task.record.scheduledAt,
        deliveredAt: new Date(
          Math.max(Date.now(), Date.parse(task.record.scheduledAt) + 1),
        ).toISOString(),
        messageId: randomUUID(),
      };
      task.lastDelivery = delivery;
      task.deliveryHistory = {
        records: [{ ...delivery, prompt: task.record.prompt }],
        earlierRecordsUnavailable: false,
      };
      task.record.scheduledAt = new Date(
        Date.parse(delivery.scheduledAt) + 86_400_000,
      ).toISOString();
      const mutation: NativeRecurringMutation = {
        kind: 'put_task',
        controlId: before.control.controlId,
        task,
      };
      const write: NativeRecurringWrite = {
        writeId: randomUUID(),
        digest: nativeOnceDigest(mutation),
        mutation,
      };
      let commitError: unknown;
      const db = interceptTransactions({
        beforeCommit: async (tx) => {
          expect(
            await tx`select write_id from allrice_native_recurring_journal where write_id=${write.writeId}`,
          ).toHaveLength(1);
          await tx`update allrice_native_once_partitions set expires_at=clock_timestamp()+interval '20 milliseconds' where partition_id=${writer.partitionId}`;
          await tx`select pg_sleep(0.04)`;
        },
      });
      // Preserve the SQL driver's actual deferred-trigger error for the assertion.
      const observed = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== 'begin') return Reflect.get(target, key, receiver);
          return async (...args: unknown[]) => {
            try {
              return await Reflect.apply(target.begin, target, args);
            } catch (error) {
              commitError = error;
              throw error;
            }
          };
        },
      });
      const expiring = createNativeRecurringSqlStore({
        db: observed,
        partitionId: writer.partitionId,
        ownerId: writer.ownerId,
        reference,
        ttlMs: 300_000,
        readiness: () => ready,
        decodeTask: (raw) => structuredClone(raw) as NativeRecurringTask,
        lockAdmission: lockNativeRecurringAdmissions,
        proveClosed: async () => null,
      });
      expect(await expiring.commitMutation(writer, write)).toBe('rejected');
      expect(commitError).toMatchObject({ code: 'P1920' });
      expect(await snapshot(rule.id)).toEqual(before);
      expect(
        await f.db`select occurrence_id from allrice_native_recurring_occurrences where automation_id=${rule.id}`,
      ).toHaveLength(0);
      expect(await store.readExactCommit(writer, write)).toBe('absent');
      expect(await store.assertWriter(writer)).toBe(true);
    });

    it('legacy due work remains legacy until reserved, and an already queued original occurrence survives enrollment unchanged', async () => {
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '0');
      const { context, rule } = await freshSchedule();
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      await f.db`update allrice_automations set next_run_at=clock_timestamp()-interval '1 second' where id=${rule.id}`;
      const before = await counts();
      await migrateOneLegacyQualitySchedule();
      const [due] =
        await f.db`select * from allrice_automations where id=${rule.id}`;
      expect(due!.clock_owner).toBe('legacy');
      expect(
        await f.db`select control_id from allrice_native_recurring_controls where automation_id=${rule.id}`,
      ).toHaveLength(0);
      expect(await qualityRows(rule.id)).toHaveLength(0);
      expect(await counts()).toEqual(before);

      const oldId = await f.db.begin(async (tx) => {
        const [r] =
          await tx`select * from allrice_automations where id=${rule.id} for update`;
        return claimPlatformQualityOccurrence(
          tx,
          r as Parameters<typeof claimPlatformQualityOccurrence>[1],
          nextScheduleAt(r!.schedule),
        );
      });
      expect(oldId).toBeTruthy();
      const original = normalize(
        await f.db`select * from allrice_automation_runs where id=${oldId!}`,
      );
      // The module's keyset cursor may need the tail/reset tick. A bounded
      // metadata rescan never consumes a queued occurrence or invents a receipt.
      let enrolled = false;
      for (let i = 0; i < 4 && !enrolled; i++) {
        await migrateOneLegacyQualitySchedule();
        enrolled =
          (
            await f.db`select control_id from allrice_native_recurring_controls where automation_id=${rule.id}`
          ).length === 1;
      }
      expect(enrolled).toBe(true);
      expect(
        normalize(
          await f.db`select * from allrice_automation_runs where id=${oldId!}`,
        ),
      ).toEqual(original);
      expect(
        await f.db`select occurrence_id from allrice_native_recurring_occurrences where automation_id=${rule.id}`,
      ).toHaveLength(0);
      expect(await counts()).toEqual(before);
      expect(await recoverPlatformQualityOccurrences()).toBe(1);
      expect(await recoverPlatformQualityOccurrences()).toBe(0);
      const row = await occurrence(oldId!);
      expect(row.native_recurring_occurrence_id).toBeNull();
      expect(row.frozen.scheduleOrigin).toEqual(
        original[0]!.quality_occurrence,
      );
      expect(row.automation_id).toBe(rule.id);
      expect(
        (await getPlatformQualitySchedule(context)).occurrences.some(
          (o) => o.id === oldId,
        ),
      ).toBe(true);
      expect(
        await f.db`select id from allrice_jobs where run_id=${row.run_id}`,
      ).toHaveLength(1);
    });

    it('records an initial Host target that skipped the original future target as missed history without a native receipt or Run', async () => {
      const { rule } = await freshSchedule();
      const before = await counts(),
        initial = await snapshot(rule.id),
        c = initial.control;
      const [version] =
        await f.db`select configuration from allrice_native_recurring_versions where automation_id=${rule.id}`;
      const originalTarget = version!.configuration
        .legacyScheduledFor as string;
      expect(originalTarget).toEqual(expect.any(String));
      await mutate({ kind: 'session_initializing', controlId: c.controlId });
      await mutate({ kind: 'session_ready', controlId: c.controlId });
      if (c.rule.kind !== 'daily') throw Error('Expected quality daily rule');
      const task: NativeRecurringTask = {
        sessionId: c.controlSessionId,
        status: 'active',
        record: {
          id: randomUUID(),
          kind: 'daily',
          time: `${c.rule.time}.000`,
          timeZone: c.rule.timezone,
          title: 'AllRice once control',
          prompt:
            'Synthetic schedule control only. Never execute business work.',
          scheduledAt: new Date(
            Date.parse(originalTarget) + 86_400_000,
          ).toISOString(),
        },
      };
      const write = await mutate({
        kind: 'put_task',
        controlId: c.controlId,
        task,
      });
      expect(await store.commitMutation(writer, write)).toBe('committed');
      const rows = await qualityRows(rule.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'failed',
        error_code: 'QUALITY_CLOCK_HANDOFF_MISSED',
        run_id: null,
        session_id: null,
        native_recurring_occurrence_id: null,
      });
      expect(rows[0]!.scheduled_for.toISOString()).toBe(originalTarget);
      expect(
        await f.db`select occurrence_id from allrice_native_recurring_occurrences where automation_id=${rule.id}`,
      ).toHaveLength(0);
      expect(await recoverPlatformQualityOccurrences()).toBe(0);
      expect(await counts()).toEqual(before);
    });

    it('rejects native provenance rewrites, mismatched original origins, and a forged business handoff without a leased receipt', async () => {
      const { rule } = await freshSchedule();
      await applyCommand(rule.id);
      const first = await receipt(rule.id);
      await dispatchNextNativeRecurringOccurrence(randomUUID());
      const [row] = await qualityRows(rule.id);
      const origin = row!.quality_occurrence as QualityScheduleOrigin;
      const [proof] =
        await f.db`select allrice_quality_native_handoff_proved(${first.native.occurrence_id}::uuid) valid`;
      expect(proof!.valid).toBe(true);
      await expect(
        f.db`update allrice_automation_runs set native_recurring_occurrence_id=null where id=${row!.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        f.db`update allrice_automation_runs set quality_occurrence=${f.db.json({ ...origin, configurationDigest: `sha256:${'c'.repeat(64)}` })} where id=${row!.id}`,
      ).rejects.toThrow('immutable');
      await expect(
        f.db`update allrice_native_recurring_occurrences set payload=jsonb_set(payload,'{receipt,messageId}',${f.db.json(randomUUID())}) where occurrence_id=${first.native.occurrence_id}`,
      ).rejects.toThrow('immutable');
      await expect(
        f.db.begin((tx) =>
          assertQualityNativeOccurrence(tx, {
            ...origin,
            configurationDigest: `sha256:${'c'.repeat(64)}`,
          }),
        ),
      ).rejects.toThrow('authorization_denied');
      await expect(
        createPlatformQualityCheck(
          admin,
          {
            requestId: qualityOccurrenceRequestId(row!.id),
            caseId: 'project.static.v1',
            variant: 'correct',
          },
          {
            scheduleOrigin: {
              ...origin,
              configurationDigest: `sha256:${'c'.repeat(64)}`,
            },
          },
        ),
      ).rejects.toThrow('authorization_denied');
      const original = normalize(
        await f.db`select * from allrice_automation_runs where id=${row!.id}`,
      );
      const second = await receipt(rule.id),
        fakeId = randomUUID();
      const forged: QualityScheduleOrigin = {
        ...origin,
        occurrenceId: fakeId,
        scheduledFor: second.delivery.scheduledAt,
        dispatchDeadlineAt: new Date(
          Date.parse(second.delivery.scheduledAt) + 15 * 60_000,
        ).toISOString(),
      };
      const before = await counts();
      await expect(
        f.db.begin(async (tx) => {
          await tx`insert into allrice_automation_runs(id,organization_id,workspace_id,automation_id,scheduled_for,quality_occurrence,status,native_recurring_occurrence_id)
          values(${fakeId},${row!.organization_id},${row!.workspace_id},${rule.id},${forged.scheduledFor}::timestamptz,${tx.json(forged)},'queued',${second.native.occurrence_id})`;
        }),
      ).rejects.toMatchObject({ code: 'P1921' });
      expect(
        normalize(
          await f.db`select * from allrice_automation_runs where id=${row!.id}`,
        ),
      ).toEqual(original);
      expect(
        await f.db`select id from allrice_automation_runs where id=${fakeId}`,
      ).toHaveLength(0);
      expect(await counts()).toEqual(before);
      // Finish the legitimate original; the unrelated fake handoff remains absent.
      expect(await recoverPlatformQualityOccurrences()).toBe(1);
      expect(
        await f.db`select id from allrice_jobs where run_id=${(await occurrence(row!.id)).run_id}`,
      ).toHaveLength(1);
    });
  },
);
