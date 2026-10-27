import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession } from '../../../../packages/database/src/workspace/service.ts';
import {
  createOnceTask,
  dispatchNextNativeOnceOccurrence,
  initializeNativeOncePartition,
  lockNativeOnceAdmissions,
} from '../../../../packages/database/src/native-schedule-once-product.ts';
import { createNativeOnceSqlStore } from '../../../../packages/database/src/native-schedule-once-sql.ts';
import {
  nativeOnceDigest,
  type NativeOnceControl,
  type NativeOnceMutation,
  type NativeOnceTask,
  type NativeOnceWriter,
} from '../../../../packages/database/src/native-schedule-once-state.ts';
import {
  claimNextJob,
  startClaimedJob,
} from '../../../../packages/database/src/execution/queue.ts';
import {
  listenForReadyJobs,
  probeReadyJobs,
} from '../../../../packages/database/src/execution/queue-ready.ts';
import type { NativeScheduleOnceStore } from '../../src/native-schedule-once.ts';
import { wakeOnDelivery } from '../../src/native-schedule-once-runtime.ts';
import {
  createCoalescedTick,
  startQueueWakeups,
} from '../../src/queue-wakeup.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

/** User view: "提醒我…" through the product API, then the native timer's
 * delivery receipt at the due time. The Worker loop here has no automation
 * poll and no queue poll: only the production delivery wakeup dispatches the
 * occurrence and only the LISTEN/NOTIFY wakeup claims and starts the Run. The
 * persisted run.started time is read back against the due time. */
suite(
  'dispatching a due reminder on its timer delivery instead of the poll (MET-223)',
  { timeout: 60_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let root: string;
    let store: ReturnType<typeof createNativeOnceSqlStore>;
    let delivering: NativeScheduleOnceStore;
    let writer: NativeOnceWriter;
    let wakeups: ReturnType<typeof startQueueWakeups> | undefined;
    const workerId = randomUUID();
    let dispatches = 0;
    // The automation tick's once consumer, woken by a committed delivery.
    const automation = createCoalescedTick(
      async () => {
        while (await dispatchNextNativeOnceOccurrence(workerId)) dispatches++;
      },
      () => true,
    );
    // The queue tick: claim, then start like runClaimedJob does first.
    const queue = createCoalescedTick(
      async () => {
        for (;;) {
          const job = await claimNextJob(workerId, 300_000);
          if (!job) return;
          await startClaimedJob(workerId, job.id, job.lease!.token);
        }
      },
      () => true,
    );
    const ready = {
      enabled: true,
      storageReady: true,
      legacyClockExcluded: true,
      controlArtifactApproved: true,
    };
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-dispatch-wakeup-')),
      );
      const reference = {
        artifactId: `sha256:${'f'.repeat(64)}`,
        profileId: 'allrice-once-control-v1',
        storageId: 'synthetic-sql-only',
        stateRoot: root,
      };
      vi.stubEnv('ALLRICE_NATIVE_ONCE_REFERENCE', JSON.stringify(reference));
      expect(await initializeNativeOncePartition(reference)).toMatchObject({
        activation: ready,
      });
      store = createNativeOnceSqlStore({
        db: f.db,
        partitionId: 'allrice-once-v1',
        ownerId: randomUUID(),
        reference,
        ttlMs: 300_000,
        readiness: () => ready,
        decodeTask: (v) => structuredClone(v) as NativeOnceTask,
        lockAdmission: lockNativeOnceAdmissions,
        proveClosed: async () => null,
      });
      // The same wrapper the Worker runtime puts around its SQL store.
      delivering = wakeOnDelivery(
        store as unknown as NativeScheduleOnceStore,
        () => automation.request(),
      );
      const grant = await store.acquireWriter();
      expect(grant).not.toBeNull();
      writer = grant!.writer;
      wakeups = startQueueWakeups({
        listen: listenForReadyJobs,
        probe: probeReadyJobs,
        wake: () => queue.request(),
        log: { info: () => {}, warn: () => {} },
      });
      await vi.waitFor(() => expect(wakeups!.status().state).toBe('listening'));
    }, 120_000);
    afterAll(async () => {
      try {
        await wakeups?.stop();
        await automation.current();
        await queue.current();
        await f?.close();
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }, 30_000);

    async function commit(
      mutation: NativeOnceMutation,
      via: Pick<NativeScheduleOnceStore, 'commitMutation'> = store as never,
    ) {
      expect(await store.renewWriter(writer)).not.toBeNull();
      expect(
        await via.commitMutation(
          writer as never,
          {
            writeId: randomUUID(),
            digest: nativeOnceDigest(mutation),
            mutation,
          } as never,
        ),
      ).toBe('committed');
    }
    const databaseNow = async () =>
      (
        await f.db<{ now: Date }[]>`select clock_timestamp() as now`
      )[0]!.now.getTime();

    it('starts the reminder within a second of its due time, with no automation poll running', async () => {
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: '客户回电',
      });
      const task = await createOnceTask(f.context, session.id, {
        clientRequestId: randomUUID(),
        name: '回电提醒',
        prompt: '提醒我下午给客户回电话，确认合同细节',
        runAt: new Date((await databaseNow()) + 7_000).toISOString(),
        timezone: 'Asia/Shanghai',
      });
      const [row] = await f.db<
        { snapshot: { control: NativeOnceControl } }[]
      >`select snapshot from allrice_native_once_controls where automation_id=${task.id}`;
      const c = row!.snapshot.control;
      await commit({ kind: 'session_initializing', controlId: c.controlId });
      await commit({ kind: 'session_ready', controlId: c.controlId });
      const dueInMs = Date.parse(c.at) - (await databaseNow()) + 20;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueInMs)));
      // The native timer fires: its delivery receipt is the only trigger.
      const delivery = {
        scheduledAt: c.at,
        deliveredAt: new Date().toISOString(),
        messageId: randomUUID(),
      };
      const control =
        'Synthetic schedule control only. Never execute business work.';
      await commit(
        {
          kind: 'put_task',
          controlId: c.controlId,
          task: {
            sessionId: c.controlSessionId,
            record: {
              id: randomUUID(),
              kind: 'at',
              title: 'AllRice once control',
              prompt: control,
              scheduledAt: c.at,
            },
            status: 'inactive',
            lastDelivery: delivery,
            deliveryHistory: {
              records: [{ ...delivery, prompt: control }],
              earlierRecordsUnavailable: false,
            },
          },
        },
        delivering,
      );
      const started = await vi.waitFor(
        async () => {
          const [run] = await f.db<
            { started_ms: number | null; status: string }[]
          >`select (extract(epoch from (select min(e.occurred_at) from allrice_run_events e
              where e.run_id=ar.run_id and e.event_type='run.started'))*1000)::float8 as started_ms,
              j.status
            from allrice_automation_runs ar join allrice_jobs j on j.run_id=ar.run_id
            where ar.automation_id=${task.id}`;
          expect(run?.started_ms).toBeTypeOf('number');
          return run!;
        },
        { timeout: 10_000, interval: 20 },
      );
      expect(dispatches).toBe(1);
      expect(started.status).toBe('running');
      // Dispatch transaction plus claim; on the 1 s poll alone this waited up
      // to a further second before dispatch even began.
      expect(started.started_ms! - Date.parse(c.at)).toBeLessThan(1_500);
    });
  },
);
