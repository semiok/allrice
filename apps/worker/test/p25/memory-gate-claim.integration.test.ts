import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  createChatSession,
  sendChatMessage,
} from '../../../../packages/database/src/workspace/service.ts';
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
import { claimNextJob } from '../../../../packages/database/src/execution/queue.ts';
import { readHostMemory, type HostMemoryProbe } from '../../src/host-memory.ts';
import {
  claimUnderMemoryGate,
  createMemoryGate,
  memoryGateSettings,
} from '../../src/memory-gate.ts';

const MiB = 1024 ** 2;
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

/** User view: a chat message and a reminder that has come due both wait in
 * the real queue. On the M1 Dev reading that held them back for up to 52 s
 * (free pages under the old 256 MB floor, kernel pressure normal) the Worker
 * claim loop takes both at once; under real critical pressure both stay
 * queued until it passes. Only the OS memory readings are injected. */
suite(
  'claiming a due reminder and a queued chat under memory pressure (MET-219)',
  { timeout: 60_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let root: string;
    let store: ReturnType<typeof createNativeOnceSqlStore>;
    let writer: NativeOnceWriter;
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
        await mkdtemp(join(tmpdir(), 'allrice-memory-gate-')),
      );
      const reference = {
        artifactId: `sha256:${'d'.repeat(64)}`,
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
      const grant = await store.acquireWriter();
      expect(grant).not.toBeNull();
      writer = grant!.writer;
    }, 120_000);
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }, 30_000);

    async function mutate(mutation: NativeOnceMutation) {
      expect(await store.renewWriter(writer)).not.toBeNull();
      const write = {
        writeId: randomUUID(),
        digest: nativeOnceDigest(mutation),
        mutation,
      };
      expect(await store.commitMutation(writer, write)).toBe('committed');
    }
    /** "提醒我…": the once task via the product API, then the native timer's
     * delivery receipt (a component-boundary value, as in the database once
     * suite), then the real dispatch that queues the reminder's Run. */
    async function dueReminder(sessionId: string, prompt: string) {
      const task = await createOnceTask(f.context, sessionId, {
        clientRequestId: randomUUID(),
        name: '回电提醒',
        prompt,
        runAt: new Date(Date.now() + 6_500).toISOString(),
        timezone: 'Asia/Shanghai',
      });
      const [row] = await f.db<
        { snapshot: { control: NativeOnceControl } }[]
      >`select snapshot from allrice_native_once_controls where automation_id=${task.id}`;
      const c = row!.snapshot.control;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(c.at) - Date.now() + 20)),
      );
      await mutate({ kind: 'session_initializing', controlId: c.controlId });
      await mutate({ kind: 'session_ready', controlId: c.controlId });
      const delivery = {
        scheduledAt: c.at,
        deliveredAt: c.at,
        messageId: randomUUID(),
      };
      const control =
        'Synthetic schedule control only. Never execute business work.';
      await mutate({
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
      });
      expect(await dispatchNextNativeOnceOccurrence(randomUUID())).toBe(true);
      const [job] = await f.db<{ id: string; status: string }[]>`
        select j.id,j.status from allrice_automation_runs ar
        join allrice_jobs j on j.run_id=ar.run_id where ar.automation_id=${task.id}`;
      expect(job?.status).toBe('queued');
      return job!.id;
    }
    async function queuedChatAndReminder() {
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
      const [chatSession, reminderSession] = await Promise.all(
        ['会议纪要', '客户回电'].map((title) =>
          createChatSession(f.context, {
            workspaceId: f.workspaceId,
            employeeAssignmentId: f.assignmentId,
            title,
          }),
        ),
      );
      const sent = await sendChatMessage(
        f.context,
        f.workspaceId,
        chatSession!.id,
        {
          clientMessageId: randomUUID(),
          text: '帮我把今天的会议纪要整理成三条要点',
          deliveryMode: 'follow_up',
        },
      );
      const reminder = await dueReminder(
        reminderSession!.id,
        '提醒我下午给客户回电话，确认合同细节',
      );
      return [sent.run.job.id, reminder].sort();
    }
    /** The macOS sysctl answer injected; free pages stay at 120 MB. */
    function gate(memorystatus: string) {
      const probe: HostMemoryProbe = {
        platform: 'darwin',
        totalBytes: 16 * 1024 * MiB,
        availableMemory: () => 120 * MiB,
        memorystatus: async () => memorystatus,
        memorystatusSync: () => memorystatus,
      };
      return createMemoryGate({
        settings: memoryGateSettings({}),
        read: () => readHostMemory(probe),
        log: () => undefined,
      });
    }
    async function workerTick(memoryGate: ReturnType<typeof gate>) {
      const workerId = randomUUID();
      const started: string[] = [];
      await claimUnderMemoryGate({
        gate: memoryGate,
        concurrency: 4,
        active: () => started.length,
        stopping: () => false,
        claim: (options) => claimNextJob(workerId, 30_000, options),
        start: (job) => started.push(job.id),
      });
      return { workerId, started: started.sort() };
    }
    const jobRows = (ids: string[]) =>
      f.db<{ id: string; status: string; worker_id: string | null }[]>`
        select id,status,worker_id from allrice_jobs where id in ${f.db(ids)} order by id`;

    it('claims both in one tick when only free pages are low and the kernel reports normal pressure', async () => {
      const ids = await queuedChatAndReminder();
      const tick = await workerTick(gate('1\n76\n'));
      expect(tick.started).toEqual(ids);
      expect(await jobRows(ids)).toEqual(
        ids.map((id) => ({ id, status: 'claimed', worker_id: tick.workerId })),
      );
    });

    it('keeps both queued under critical pressure and claims them once it passes', async () => {
      const ids = await queuedChatAndReminder();
      const paused = await workerTick(gate('4\n9\n'));
      expect(paused.started).toEqual([]);
      expect(await jobRows(ids)).toEqual(
        ids.map((id) => ({ id, status: 'queued', worker_id: null })),
      );
      const resumed = await workerTick(gate('1\n70\n'));
      expect(resumed.started).toEqual(ids);
      expect(await jobRows(ids)).toEqual(
        ids.map((id) => ({
          id,
          status: 'claimed',
          worker_id: resumed.workerId,
        })),
      );
    });
  },
);
