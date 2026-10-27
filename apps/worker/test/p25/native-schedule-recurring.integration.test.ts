import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession } from '../../../../packages/database/src/workspace/service.ts';
import {
  changeRecurringTask,
  createRecurringTask,
  dispatchNextNativeRecurringOccurrence,
  getRecurringTask,
  initializeNativeRecurringPartition,
} from '../../../../packages/database/src/native-schedule-recurring-product.ts';
import type {
  NativeRecurringSnapshot,
  NativeRecurringTask,
} from '../../../../packages/database/src/native-schedule-recurring-state.ts';
import { nativeOnceDigest } from '../../../../packages/database/src/native-schedule-once-state.ts';
import type { NativeOnceClosedProof } from '../../../../packages/database/src/native-schedule-control-sql.ts';
import { measureDshNativeArtifact } from '../../src/harness/dsh-native-artifact.ts';
import {
  createNativeOnceControlSource,
  verifyNativeOnceControlHistory,
  type NativeOnceLoaderTestPorts,
} from '../../src/native-schedule-once-loader.ts';
import { checkNativeReleaseCandidate } from '../../src/harness/dsh-native-release-check.ts';
import { createNativeOnceWorkerRuntime } from '../../src/native-schedule-once-runtime.ts';

// This additional public-Host check follows the existing DB integration opt-in,
// with the same explicit module-base opt-in as the controller's real Host probe.
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1' &&
  !!process.env.ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE
    ? describe.sequential
    : describe.skip;

/** Real Schedule timers, production recurring SQL and runtime profile routing.
 * The registry seam approves only this measured test tree, never a Dev artifact.
 * No employee job runner or provider adapter is invoked. */
suite(
  'recurring real public Host and isolated PostgreSQL',
  { timeout: 180_000 },
  () => {
    let fixture: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let stateRoot: string;
    let controlPorts: NativeOnceLoaderTestPorts;
    let primary: { artifactId: string; generation: string };
    let source: ReturnType<typeof createNativeOnceControlSource>;
    const runtimes: ReturnType<typeof createNativeOnceWorkerRuntime>[] = [];

    beforeAll(async () => {
      const root = await realpath(
        fileURLToPath(new URL('../../../../', import.meta.url)),
      );
      expect(
        await realpath(process.env.ALLRICE_NATIVE_ONCE_PROBE_MODULE_BASE!),
      ).toBe(join(root, 'apps/worker/package.json'));
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      fixture = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      const [scope] = await fixture.db`select current_schema() as schema`;
      expect(scope?.schema).toBe(fixture.schema);
      expect(fixture.schema).toMatch(/^p25_[a-f0-9]{32}$/);
      stateRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-recurring-host-sql-')),
      );
      const measured = await measureDshNativeArtifact(root);
      // MET-221: the partition was born under an earlier release of the same
      // generation; the primary below runs it and the reference stays exact.
      const reference = {
        artifactId: 'sha256:' + 'e'.repeat(64),
        profileId: 'allrice-recurring-control-v1',
        storageId: 'isolated-real-recurring-host-sql',
        stateRoot,
      };
      vi.stubEnv(
        'ALLRICE_NATIVE_RECURRING_REFERENCE',
        JSON.stringify(reference),
      );
      controlPorts = {
        currentArtifact: () => ({
          artifactId: measured.artifactId,
          generation: measured.content.generation,
          root,
          content: measured.content,
        }),
      };
      primary = {
        artifactId: measured.artifactId,
        generation: measured.content.generation,
      };
      source = createNativeOnceControlSource(reference, controlPorts);
      await initializeNativeRecurringPartition(reference);
    }, 120_000);

    afterAll(async () => {
      // A failed public drain must retain the schema/root for diagnosis. Never
      // manufacture closed state or drop persistence underneath a live Host.
      try {
        for (const runtime of runtimes) await runtime.stop();
        const cleanup = await fixture?.close();
        if (cleanup) {
          expect(cleanup.globalDatabaseClosed).toBe(true);
          expect(cleanup.databaseEnvironmentRestored).toBe(true);
          expect(cleanup.fixture?.schemaRemoved).toBe(true);
          expect(cleanup.fixture?.storageRemoved).toBe(true);
        }
        if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
      } finally {
        vi.unstubAllEnvs();
      }
    }, 30_000);

    function runtime() {
      const value = createNativeOnceWorkerRuntime({
        enabled: true,
        workerId: randomUUID(),
        reference: source.reference,
        loadModules: () => source.loadModules(),
        loadHostFactory: () => source.loadHostFactory(),
      });
      runtimes.push(value);
      return value;
    }
    async function snapshot(automationId: string) {
      const [row] = await fixture.db<{ snapshot: NativeRecurringSnapshot }[]>`
      select snapshot from allrice_native_recurring_controls where automation_id=${automationId}`;
      expect(row).toBeDefined();
      return row!.snapshot;
    }
    async function tick(value: ReturnType<typeof runtime>) {
      await value.tick();
      expect(
        value.status().controller?.stats.adapterCalls,
        JSON.stringify(value.status()),
      ).toBe(0);
      expect(value.status().state, JSON.stringify(value.status())).toBe(
        'active',
      );
    }
    async function waitForReceipts(
      value: ReturnType<typeof runtime>,
      automationId: string,
      count: number,
      target: string,
    ) {
      const deadline = Date.parse(target) + 12_000;
      let result = await snapshot(automationId);
      while (Date.now() < deadline) {
        await tick(value);
        result = await snapshot(automationId);
        const task = result.task as NativeRecurringTask | null;
        if ((task?.deliveryHistory?.records.length ?? 0) >= count)
          return result;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(
        JSON.stringify({
          reason: 'real_native_receipt_not_observed',
          count,
          target,
          snapshot: result,
          runtime: value.status(),
        }),
      );
    }
    async function partition() {
      const [row] = await fixture.db<
        {
          epoch: number | string;
          owner_id: string;
          token_digest: string;
          reference: typeof source.reference;
          closed: boolean;
          close_proof: NativeOnceClosedProof | null;
        }[]
      >`select epoch,owner_id,token_digest,reference,closed,close_proof
      from allrice_native_once_partitions where partition_id='allrice-recurring-v1'`;
      expect(row).toBeDefined();
      return row!;
    }
    async function assertQueuedRuns(
      automationId: string,
      sessionId: string,
      count: number,
    ) {
      const rows =
        await fixture.db`select o.occurrence_id,o.payload,o.outbox_state,o.business_binding,
      ar.run_id,ar.session_id,j.status,m.content->>'text' as text
      from allrice_native_recurring_occurrences o
      join allrice_automation_runs ar on ar.native_recurring_occurrence_id=o.occurrence_id
      join allrice_employee_runs er on er.run_id=ar.run_id
      join allrice_jobs j on j.run_id=ar.run_id
      join allrice_messages m on m.id=er.user_message_id
      where o.automation_id=${automationId} order by o.scheduled_at`;
      expect(rows).toHaveLength(count);
      expect(new Set(rows.map((r) => r.run_id)).size).toBe(count);
      for (const row of rows) {
        expect(row.outbox_state).toBe('enqueued');
        expect(row.status).toBe('queued');
        expect(row.session_id).toBe(sessionId);
        expect(row.business_binding.runId).toBe(row.run_id);
      }
      return Array.from(rows);
    }

    it('delivers every then daily on the same Task/Session, genuinely closes/cold restores history, and deletes without a model', async () => {
      const chat = await createChatSession(fixture.context, {
        workspaceId: fixture.workspaceId,
        employeeAssignmentId: fixture.assignmentId,
        title: 'Real recurring timer, no model',
      });
      const input = {
        clientRequestId: randomUUID(),
        name: '真实周期核对',
        prompt: '仅回复每期固定校验词 RECURRING-HOST-SQL-ONE。',
        rule: { kind: 'every' as const, seconds: 60 },
      };
      const created = await createRecurringTask(
        fixture.context,
        chat.id,
        input,
      );
      const first = runtime();
      await tick(first);
      const initial = await snapshot(created.id);
      expect(initial.control).toMatchObject({
        sessionState: 'ready',
        command: { status: 'confirmed' },
        appliedRevision: 1,
        appliedRule: input.rule,
        nativeTaskId: expect.any(String),
      });
      const initialTask = initial.task as NativeRecurringTask;
      expect(initialTask.record).toMatchObject({
        kind: 'every',
        everySeconds: 60,
      });
      expect(
        Date.parse(initialTask.record.scheduledAt) - Date.now(),
      ).toBeGreaterThan(45_000);
      expect(await assertQueuedRuns(created.id, chat.id, 0)).toEqual([]);
      const live = await partition();
      expect(live.closed).toBe(false);
      expect(live.close_proof).toBeNull();

      const every = await waitForReceipts(
        first,
        created.id,
        1,
        initialTask.record.scheduledAt,
      );
      const everyTask = every.task as NativeRecurringTask;
      expect(everyTask.deliveryHistory?.records).toHaveLength(1);
      expect(everyTask.lastDelivery?.scheduledAt).toBe(
        initialTask.record.scheduledAt,
      );
      const firstRuns = await assertQueuedRuns(created.id, chat.id, 1);
      expect(firstRuns[0]!.payload.receipt).toEqual(
        everyTask.deliveryHistory!.records[0],
      );
      expect(firstRuns[0]!.payload.revision.revision).toBe(1);
      expect(firstRuns[0]!.text).toContain(input.prompt);

      // Use real wall time and the public daily rule. No clock/mutation/receipt
      // injection; at UTC midnight the next civil day is naturally selected.
      const target = new Date(Math.ceil((Date.now() + 8_000) / 1_000) * 1_000);
      const rule = {
        kind: 'daily' as const,
        time: target.toISOString().slice(11, 19),
        timezone: 'UTC',
      };
      const update = {
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'update' as const,
        name: 'UTC新版核对',
        prompt: '仅回复每期固定校验词 RECURRING-HOST-SQL-TWO。',
        rule,
      };
      expect(
        await changeRecurringTask(fixture.context, chat.id, created.id, update),
      ).toMatchObject({ status: 'pending' });
      await tick(first);
      const changed = await snapshot(created.id);
      expect(changed.control).toMatchObject({
        controlSessionId: initial.control.controlSessionId,
        nativeTaskId: initial.control.nativeTaskId,
        command: { id: update.operationId, status: 'confirmed' },
        revision: 2,
        appliedRevision: 2,
        appliedRule: rule,
      });
      const changedTask = changed.task as NativeRecurringTask;
      expect(changedTask.record).toMatchObject({
        id: initialTask.record.id,
        kind: 'daily',
        time: `${rule.time}.000`,
        timeZone: 'UTC',
      });
      expect(changedTask.record.scheduledAt).toBe(target.toISOString());
      expect(changedTask.deliveryHistory).toEqual(everyTask.deliveryHistory);
      const daily = await waitForReceipts(
        first,
        created.id,
        2,
        changedTask.record.scheduledAt,
      );
      const dailyTask = daily.task as NativeRecurringTask;
      expect(dailyTask.deliveryHistory?.records).toHaveLength(2);
      expect(dailyTask.deliveryHistory?.records[0]).toEqual(
        everyTask.deliveryHistory!.records[0],
      );
      expect(dailyTask.lastDelivery?.scheduledAt).toBe(target.toISOString());
      const bothRuns = await assertQueuedRuns(created.id, chat.id, 2);
      expect(bothRuns[1]!.payload.receipt).toEqual(
        dailyTask.deliveryHistory!.records[1],
      );
      expect(bothRuns[1]!.payload.revision.revision).toBe(2);
      expect(bothRuns[1]!.text).toContain(update.prompt);
      expect(bothRuns[1]!.text).not.toContain(input.prompt);
      await tick(first);
      expect(await dispatchNextNativeRecurringOccurrence(randomUUID())).toBe(
        false,
      );
      expect(await assertQueuedRuns(created.id, chat.id, 2)).toEqual(bothRuns);

      await first.stop();
      expect(first.status().controller?.stats.adapterCalls).toBe(0);
      const closed = await partition();
      expect(closed.closed).toBe(true);
      expect(closed.close_proof).toMatchObject({
        kind: 'public_host_backend_drained',
        partitionId: 'allrice-recurring-v1',
        ownerId: live.owner_id,
        epoch: Number(live.epoch),
        tokenDigest: live.token_digest,
        evidence: {
          contract:
            'public_schedule_sdk_root_close_then_both_backends_and_writes',
          referenceDigest: nativeOnceDigest(source.reference),
          publicHostCloseCompletedAt: expect.any(String),
          scheduleBackendDrainCompletedAt: expect.any(String),
          auxiliaryBackendDrainCompletedAt: expect.any(String),
          backendDrainCompletedAt: expect.any(String),
          controllerReleaseBoundaryAt: expect.any(String),
        },
      });
      const proofRows =
        await fixture.db`select proof from allrice_native_once_close_proofs
      where partition_id='allrice-recurring-v1' and epoch=${Number(closed.epoch)}`;
      expect(proofRows).toHaveLength(1);
      expect(proofRows[0]!.proof).toEqual(closed.close_proof);
      // With the Worker stopped, deploy-dev's pre-stop check reads this
      // control's history through the current primary (MET-221 PR2b-1).
      const released = await checkNativeReleaseCandidate(primary, {
        sql: fixture.db,
        verifyControlHistory: (ref, controls) =>
          verifyNativeOnceControlHistory(ref, controls, controlPorts),
      });
      expect(released.contexts.controlPartitions).toBe(1);
      expect(released.contexts.controlSessionsVerified).toBeGreaterThanOrEqual(
        1,
      );

      const second = runtime();
      await tick(second);
      const resumed = await partition();
      expect(Number(resumed.epoch)).toBe(Number(closed.epoch) + 1);
      expect(resumed.closed).toBe(false);
      expect(resumed.reference).toEqual(closed.reference);
      expect(await snapshot(created.id)).toEqual(daily);
      expect(
        (
          await fixture.db`select proof from allrice_native_once_close_proofs
      where partition_id='allrice-recurring-v1' and epoch=${Number(closed.epoch)}`
        )[0]!.proof,
      ).toEqual(closed.close_proof);
      await tick(second);
      expect(await assertQueuedRuns(created.id, chat.id, 2)).toEqual(bothRuns);

      const remove = {
        operationId: randomUUID(),
        expectedRevision: 2,
        action: 'delete' as const,
      };
      expect(
        await changeRecurringTask(fixture.context, chat.id, created.id, remove),
      ).toMatchObject({ status: 'pending' });
      await tick(second);
      const deleted = await snapshot(created.id);
      expect(deleted.control).toMatchObject({
        controlSessionId: initial.control.controlSessionId,
        nativeTaskId: initial.control.nativeTaskId,
        taskDeleted: true,
        command: {
          id: remove.operationId,
          kind: 'delete',
          status: 'confirmed',
        },
      });
      expect(deleted.task).toBeNull();
      const detail = await getRecurringTask(
        fixture.context,
        chat.id,
        created.id,
      );
      expect(detail).toMatchObject({ task: { status: 'deleted' } });
      expect('occurrences' in detail && detail.occurrences).toHaveLength(2);
      await tick(second);
      expect(await assertQueuedRuns(created.id, chat.id, 2)).toEqual(bothRuns);
      await second.stop();
      const final = await partition();
      expect(final.closed).toBe(true);
      expect(final.close_proof?.kind).toBe('public_host_backend_drained');
      expect(Number(final.epoch)).toBe(Number(closed.epoch) + 1);
      expect(final.close_proof?.proofId).not.toBe(closed.close_proof!.proofId);
      for (const value of runtimes)
        expect(value.status().controller?.stats.adapterCalls).toBe(0);
    });
  },
);
