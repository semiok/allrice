import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformQualityNativeFixture } from '../../../../packages/database/src/platform-quality-native.fixture.ts';
import {
  deletePlatformQualitySchedule,
  dispatchPlatformQualityOccurrence,
  getPlatformQualitySchedule,
  qualityOccurrenceRequestId,
  recoverPlatformQualityOccurrences,
  updatePlatformQualitySchedule,
} from '../../../../packages/database/src/platform-quality-automation.ts';
import {
  cancelPlatformQualityCheck,
  getPlatformQualityCheck,
} from '../../../../packages/database/src/platform-quality.ts';
import {
  dispatchNextNativeRecurringOccurrence,
  initializeNativeRecurringPartition,
} from '../../../../packages/database/src/native-schedule-recurring-product.ts';
import type {
  NativeRecurringSnapshot,
  NativeRecurringTask,
} from '../../../../packages/database/src/native-schedule-recurring-state.ts';
import { nativeOnceDigest } from '../../../../packages/database/src/native-schedule-once-state.ts';
import type { NativeOnceClosedProof } from '../../../../packages/database/src/native-schedule-control-sql.ts';
import { cloudStableId } from '../../../../packages/database/src/cloud-execution.ts';
import { measureDshNativeArtifact } from '../../src/harness/dsh-native-artifact.ts';
import { createNativeOnceControlSource } from '../../src/native-schedule-once-loader.ts';
import { createNativeOnceWorkerRuntime } from '../../src/native-schedule-once-runtime.ts';

// Same explicit DB/public-module opt-in as the existing recurring Host test.
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  !!process.env.ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE
    ? describe.sequential
    : describe.skip;

/** Actual public daily timer -> production SQL -> original durable quality
 * queue -> one real private Run/Job. No Worker/provider executor is imported. */
suite(
  'platform quality real public daily Host and isolated PostgreSQL',
  { timeout: 180_000 },
  () => {
    let fixture: Awaited<ReturnType<typeof createPlatformQualityNativeFixture>>;
    let source: ReturnType<typeof createNativeOnceControlSource>;
    let runtime: ReturnType<typeof createNativeOnceWorkerRuntime> | undefined;
    let stateRoot: string, schema: string;
    const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));

    beforeAll(async () => {
      const root = await realpath(
        fileURLToPath(new URL('../../../../', import.meta.url)),
      );
      expect(
        await realpath(process.env.ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE!),
      ).toBe(join(root, 'apps/worker/package.json'));
      fixture = await createPlatformQualityNativeFixture();
      const [scope] = await fixture.db`select current_schema() as schema`;
      schema = scope!.schema;
      expect(schema).toMatch(/^p25_[a-f0-9]{32}$/);
      const namespaces = await fixture.db`select n.nspname from pg_class c
        join pg_namespace n on n.oid=c.relnamespace
        where c.oid in ('allrice_native_recurring_controls'::regclass,'allrice_native_recurring_occurrences'::regclass,
          'allrice_platform_quality_checks'::regclass,'allrice_automation_runs'::regclass,'allrice_jobs'::regclass)`;
      expect(namespaces).toHaveLength(5);
      expect(namespaces.every((r) => r.nspname === schema)).toBe(true);
      stateRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-quality-public-host-')),
      );
      const measured = await measureDshNativeArtifact(root);
      const reference = {
        artifactId: measured.artifactId,
        profileId: 'allrice-recurring-control-v1',
        storageId: 'isolated-quality-public-daily',
        stateRoot,
      };
      vi.stubEnv(
        'ALLRICE_NATIVE_RECURRING_REFERENCE',
        JSON.stringify(reference),
      );
      // Approve only this actually measured tree at the existing registry seam.
      // Modules, exact source verification, Host and database ports stay real.
      source = createNativeOnceControlSource(reference, {
        currentArtifact: () => ({
          artifactId: measured.artifactId,
          generation: measured.content.generation,
          root,
          content: measured.content,
        }),
      });
      await initializeNativeRecurringPartition(reference);
    }, 120_000);

    async function partition() {
      const [row] = await fixture.db<
        {
          epoch: number | string;
          owner_id: string | null;
          token_digest: string | null;
          reference: typeof source.reference;
          closed: boolean;
          close_proof:
            NativeOnceClosedProof | { kind: 'never_acquired' } | null;
        }[]
      >`select epoch,owner_id,token_digest,reference,closed,close_proof
        from allrice_native_once_partitions where partition_id='allrice-recurring-v1'`;
      expect(row).toBeDefined();
      return row!;
    }
    async function snapshot(id: string) {
      const [row] = await fixture.db<{ snapshot: NativeRecurringSnapshot }[]>`
        select snapshot from allrice_native_recurring_controls where automation_id=${id}`;
      expect(row).toBeDefined();
      return row!.snapshot;
    }
    async function assertPublicClose() {
      const p = await partition();
      const proof = p.close_proof;
      expect(p.closed).toBe(true);
      expect(proof).toMatchObject({
        kind: 'public_host_backend_drained',
        partitionId: 'allrice-recurring-v1',
        ownerId: p.owner_id,
        epoch: Number(p.epoch),
        tokenDigest: p.token_digest,
        evidence: {
          contract:
            'public_schedule_sdk_root_close_then_both_backends_and_writes',
          referenceDigest: nativeOnceDigest(source.reference),
        },
      });
      if (!proof || proof.kind !== 'public_host_backend_drained')
        throw Error('Public close proof required');
      const sequence = [
        'publicHostCloseCompletedAt',
        'scheduleBackendDrainCompletedAt',
        'auxiliaryBackendDrainCompletedAt',
        'backendDrainCompletedAt',
        'controllerReleaseBoundaryAt',
      ].map((key) => {
        expect(proof.evidence[key]).toEqual(expect.any(String));
        const time = Date.parse(proof.evidence[key] as string);
        expect(Number.isFinite(time)).toBe(true);
        return time;
      });
      expect(sequence).toEqual([...sequence].sort((a, b) => a - b));
      expect(sequence.at(-1)).toBeLessThanOrEqual(Date.now());
      const audit =
        await fixture.db`select proof from allrice_native_once_close_proofs
        where partition_id='allrice-recurring-v1' and epoch=${Number(p.epoch)}`;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.proof).toEqual(proof);
      expect(p.reference).toEqual(source.reference);
      expect(runtime!.status().state).toBe('closed');
      expect(runtime!.status().controller?.stats.adapterCalls).toBe(0);
      return p;
    }
    afterAll(async () => {
      // stop() must really close the public Host and both backends. If it or its
      // proof is unconfirmed, retain this schema/root rather than force cleanup.
      try {
        if (runtime) {
          await runtime.stop();
          const p = await partition();
          if (Number(p.epoch) > 0) await assertPublicClose();
          else
            expect(p).toMatchObject({
              closed: true,
              close_proof: { kind: 'never_acquired' },
            });
        }
        const cleanup = await fixture?.close();
        if (cleanup)
          expect(cleanup).toMatchObject({
            schema,
            schemaRemoved: true,
            storageRemoved: true,
            databaseClosed: true,
            adminClosed: true,
          });
        if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
      } catch (error) {
        throw new Error(
          `Quality native cleanup not confirmed; retained schema=${schema} root=${stateRoot}`,
          { cause: error },
        );
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }, 30_000);

    async function tick() {
      await runtime!.tick();
      expect(
        runtime!.status().controller?.stats.adapterCalls,
        JSON.stringify(runtime!.status()),
      ).toBe(0);
      expect(runtime!.status().state, JSON.stringify(runtime!.status())).toBe(
        'active',
      );
    }
    async function businessRows(automationId: string) {
      return fixture.db`select ar.*,q.id check_id,q.job_id,q.frozen,
        j.status job_status,er.owner_id employee_owner,er.employee_assignment_id
        from allrice_automation_runs ar left join allrice_platform_quality_checks q on q.automation_run_id=ar.id
        left join allrice_jobs j on j.id=q.job_id left join allrice_employee_runs er on er.run_id=ar.run_id
        where ar.automation_id=${automationId} order by ar.created_at,ar.id`;
    }
    async function usage() {
      const [row] = await fixture.db`select
        (select count(*)::int from allrice_route_decisions) routes,
        (select count(*)::int from allrice_model_usage_ledger) ledger,
        (select count(*)::int from allrice_task_calls) calls`;
      return row!;
    }

    it('delivers the frozen Shanghai target once into the original private queue, pauses/deletes the same Task, and publicly drains', async () => {
      const deadline = performance.now() + 180_000;
      // The next eligible local minute leaves at least 30s for real Host boot.
      // This can be the following minute when the immediate next is too near.
      const target = new Date(
        Math.ceil((Date.now() + 30_000) / 60_000) * 60_000,
      );
      expect(target.getTime() - Date.now()).toBeGreaterThanOrEqual(29_900);
      const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(target);
      const { admin } = fixture;
      const beforeUsage = await usage();
      expect(beforeUsage).toEqual({ routes: 0, ledger: 0, calls: 0 });
      const originalCompany = normalized(
        await fixture.db`select * from allrice_runs where id=${fixture.company.run}`,
      );
      const logins = normalized(
        await fixture.db`select id,user_id,created_at,expires_at,revoked_at from allrice_sessions order by id`,
      );
      const configured = await updatePlatformQualitySchedule(admin, {
        expectedRevision: 0,
        enabled: true,
        time,
      });
      const rule = configured.schedule!;
      expect(rule).toMatchObject({
        enabled: true,
        time,
        timezone: 'Asia/Shanghai',
      });
      const [plan] =
        await fixture.db`select * from allrice_automations where id=${rule.id}`;
      expect(plan).toMatchObject({
        id: rule.id,
        owner_id: admin.actor.id,
        clock_owner: 'native_recurring',
        conversation_mode: 'new_each_run',
        session_id: null,
        schedule: { frequency: 'daily', time, timezone: 'Asia/Shanghai' },
      });
      const [version] =
        await fixture.db`select configuration from allrice_native_recurring_versions where automation_id=${rule.id} and revision=1`;
      expect(version!.configuration.legacyScheduledFor).toBe(
        target.toISOString(),
      );

      runtime = createNativeOnceWorkerRuntime({
        enabled: true,
        workerId: randomUUID(),
        reference: source.reference,
        loadModules: () => source.loadModules(),
        loadHostFactory: () => source.loadHostFactory(),
      });
      await tick();
      const initial = await snapshot(rule.id),
        firstTask = initial.task as NativeRecurringTask;
      expect(initial.control).toMatchObject({
        dispatch: { consumer: 'platform-quality-v1' },
        sessionState: 'ready',
        nativeTaskId: expect.any(String),
        appliedRevision: 1,
        command: { kind: 'create', status: 'confirmed' },
        appliedRule: {
          kind: 'daily',
          time: `${time}:00`,
          timezone: 'Asia/Shanghai',
        },
      });
      expect(firstTask.record).toMatchObject({
        kind: 'daily',
        time: `${time}:00.000`,
        timeZone: 'Asia/Shanghai',
      });
      expect(firstTask.record.scheduledAt).toBe(target.toISOString());
      expect(firstTask.lastDelivery).toBeUndefined();
      expect(firstTask.deliveryHistory?.records ?? []).toHaveLength(0);
      expect(await businessRows(rule.id)).toHaveLength(0);
      const live = await partition();
      expect(live.closed).toBe(false);
      expect(live.close_proof).toBeNull();

      const receiptDeadline = Math.min(
        deadline,
        performance.now() + target.getTime() - Date.now() + 15_000,
      );
      let received: NativeRecurringSnapshot | undefined;
      while (performance.now() < receiptDeadline) {
        await tick();
        const current = await snapshot(rule.id),
          task = current.task as NativeRecurringTask;
        if (
          (task.deliveryHistory?.records.length ?? 0) === 1 &&
          (await businessRows(rule.id)).length === 1
        ) {
          received = current;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(
        received,
        JSON.stringify({
          target: target.toISOString(),
          runtime: runtime.status(),
          snapshot: await snapshot(rule.id),
        }),
      ).toBeDefined();
      const task = received!.task as NativeRecurringTask;
      expect(task.deliveryHistory!.records).toHaveLength(1);
      const actual = task.deliveryHistory!.records[0]!;
      expect(actual.scheduledAt).toBe(firstTask.record.scheduledAt);
      expect(Date.parse(actual.deliveredAt)).toBeGreaterThanOrEqual(
        target.getTime(),
      );
      expect(Date.parse(actual.deliveredAt)).toBeLessThanOrEqual(Date.now());
      expect(task.lastDelivery).toMatchObject({
        scheduledAt: actual.scheduledAt,
        deliveredAt: actual.deliveredAt,
        messageId: actual.messageId,
      });
      const native =
        await fixture.db`select * from allrice_native_recurring_occurrences where automation_id=${rule.id}`;
      expect(native).toHaveLength(1);
      expect(native[0]!.payload.receipt).toEqual(actual);
      expect(native[0]!.outbox_state).toBe('enqueued');
      const queued = await businessRows(rule.id);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        id: cloudStableId(`quality-native:${native[0]!.occurrence_id}`),
        automation_id: rule.id,
        native_recurring_occurrence_id: native[0]!.occurrence_id,
        run_id: null,
        session_id: null,
        status: 'queued',
        check_id: null,
        job_id: null,
      });
      expect(queued[0]!.scheduled_for.toISOString()).toBe(actual.scheduledAt);
      expect(queued[0]!.quality_occurrence.scheduledFor).toBe(
        actual.scheduledAt,
      );
      expect(native[0]!.business_binding).toMatchObject({
        consumer: 'platform-quality-v1',
        automationRunId: queued[0]!.id,
        origin: queued[0]!.quality_occurrence,
        payloadDigest: native[0]!.payload_digest,
      });
      const [proof] =
        await fixture.db`select allrice_quality_native_handoff_proved(${native[0]!.occurrence_id}::uuid) valid`;
      expect(proof!.valid).toBe(true);

      expect(await recoverPlatformQualityOccurrences()).toBe(1);
      const [bound] = await businessRows(rule.id);
      expect(bound!.run_id).toEqual(expect.any(String));
      expect(bound!.session_id).toEqual(expect.any(String));
      expect(bound).toMatchObject({
        id: queued[0]!.id,
        automation_id: rule.id,
        job_status: 'queued',
        employee_owner: admin.actor.id,
        employee_assignment_id: plan!.employee_assignment_id,
      });
      expect(bound!.frozen.scheduleOrigin).toEqual(
        queued[0]!.quality_occurrence,
      );
      expect(bound!.frozen.requestId).toBe(
        qualityOccurrenceRequestId(bound!.id),
      );
      expect(bound!.frozen.loginSessionId).toBeUndefined();
      expect(
        await fixture.db`select id from allrice_jobs where run_id=${bound!.run_id}`,
      ).toHaveLength(1);
      expect(
        await fixture.db`select id from allrice_chat_sessions where id=${bound!.session_id} and owner_id=${admin.actor.id} and workspace_id=${plan!.workspace_id}`,
      ).toHaveLength(1);
      await expect(
        getPlatformQualityCheck(fixture.company.owner, bound!.check_id),
      ).rejects.toThrow('authorization_denied');
      expect(await dispatchPlatformQualityOccurrence(bound!.id)).toBe(false);
      expect(await recoverPlatformQualityOccurrences()).toBe(0);

      const paused = await updatePlatformQualitySchedule(admin, {
        expectedRevision: rule.revision,
        enabled: false,
        time,
      });
      expect(paused.schedule).toMatchObject({ id: rule.id, enabled: false });
      await tick();
      const pausedSnapshot = await snapshot(rule.id);
      expect(pausedSnapshot.control).toMatchObject({
        controlSessionId: initial.control.controlSessionId,
        nativeTaskId: initial.control.nativeTaskId,
        command: { kind: 'update', status: 'confirmed' },
      });
      expect(
        (pausedSnapshot.task as NativeRecurringTask).deliveryHistory,
      ).toEqual(task.deliveryHistory);
      for (let i = 0; i < 3; i++) await tick();
      expect(await recoverPlatformQualityOccurrences()).toBe(0);
      expect(await businessRows(rule.id)).toHaveLength(1);
      expect((await businessRows(rule.id))[0]!.run_id).toBe(bound!.run_id);

      await deletePlatformQualitySchedule(admin, {
        expectedRevision: paused.schedule!.revision,
      });
      await tick();
      const deleted = await snapshot(rule.id);
      expect(deleted.control).toMatchObject({
        controlSessionId: initial.control.controlSessionId,
        nativeTaskId: initial.control.nativeTaskId,
        taskDeleted: true,
        command: { kind: 'delete', status: 'confirmed' },
      });
      expect(deleted.task).toBeNull();
      expect(
        (await getPlatformQualitySchedule(admin)).occurrences.some(
          (o) => o.id === bound!.id,
        ),
      ).toBe(true);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      expect(await recoverPlatformQualityOccurrences()).toBe(0);
      expect(await businessRows(rule.id)).toHaveLength(1);
      expect(await usage()).toEqual(beforeUsage);
      expect(
        normalized(
          await fixture.db`select id,user_id,created_at,expires_at,revoked_at from allrice_sessions order by id`,
        ),
      ).toEqual(logins);
      expect(
        normalized(
          await fixture.db`select * from allrice_runs where id=${fixture.company.run}`,
        ),
      ).toEqual(originalCompany);
      await cancelPlatformQualityCheck(admin, bound!.check_id);

      await runtime.stop();
      const closed = await assertPublicClose();
      expect(closed).toMatchObject({
        epoch: live.epoch,
        owner_id: live.owner_id,
        token_digest: live.token_digest,
        reference: live.reference,
      });
      expect(performance.now()).toBeLessThan(deadline);
    });
  },
);
