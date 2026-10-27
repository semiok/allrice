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
import type {
  NativeScheduleOnceStore,
  NativeScheduleWrite,
} from '../../src/native-schedule-once.ts';
import { wakeOnDelivery } from '../../src/native-schedule-once-runtime.ts';
import { createCoalescedTick } from '../../src/queue-wakeup.ts';
import { closeWorkerResources } from '../../src/worker-shutdown.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Fault injection at the SQL/Worker ports; no real timer or OS signal is claimed.
suite(
  'MET-223 delivery recovery against isolated PostgreSQL',
  { timeout: 30_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let root: string, writer: NativeOnceWriter;
    let store: ReturnType<typeof createNativeOnceSqlStore>;
    let port: NativeScheduleOnceStore;
    const workerId = randomUUID();
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      root = await realpath(await mkdtemp(join(tmpdir(), 'met223-recovery-')));
      const reference = {
        artifactId: `sha256:${'f'.repeat(64)}`,
        profileId: 'allrice-once-control-v1',
        storageId: 'synthetic-recovery-sql',
        stateRoot: root,
      };
      vi.stubEnv('ALLRICE_NATIVE_ONCE_REFERENCE', JSON.stringify(reference));
      const ready = {
        enabled: true,
        storageReady: true,
        legacyClockExcluded: true,
        controlArtifactApproved: true,
      };
      await initializeNativeOncePartition(reference);
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
      port = store as unknown as NativeScheduleOnceStore;
      writer = (await store.acquireWriter())!.writer;
    }, 120_000);
    afterAll(async () => {
      try {
        const cleanup = await f?.close();
        if (cleanup) expect(cleanup.fixture?.schemaRemoved).toBe(true);
        if (root) await rm(root, { recursive: true, force: true });
      } finally {
        vi.unstubAllEnvs();
      }
    }, 30_000);
    const write = (mutation: NativeOnceMutation): NativeScheduleWrite =>
      ({
        writeId: randomUUID(),
        digest: nativeOnceDigest(mutation),
        mutation,
      }) as NativeScheduleWrite;
    async function reminder() {
      expect(await store.renewWriter(writer)).not.toBeNull();
      const chat = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: '回电提醒恢复',
      });
      const [clock] = await f.db<
        { now: Date }[]
      >`select clock_timestamp() as now`;
      const task = await createOnceTask(f.context, chat.id, {
        clientRequestId: randomUUID(),
        name: '回电提醒',
        prompt: '提醒我给客户回电话',
        // The public API requires a target more than five seconds in the future.
        runAt: new Date(clock!.now.getTime() + 7_000).toISOString(),
        timezone: 'Asia/Shanghai',
      });
      const [row] = await f.db<
        { snapshot: { control: NativeOnceControl } }[]
      >`select snapshot from allrice_native_once_controls where automation_id=${task.id}`;
      const c = row!.snapshot.control;
      for (const kind of ['session_initializing', 'session_ready'] as const)
        expect(
          await port.commitMutation(
            writer,
            write({ kind, controlId: c.controlId }),
          ),
        ).toBe('committed');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(c.at) - Date.now() + 20)),
      );
      const delivery = {
        scheduledAt: c.at,
        deliveredAt: new Date().toISOString(),
        messageId: randomUUID(),
      };
      const prompt =
        'Synthetic schedule control only. Never execute business work.';
      const mutation: NativeOnceMutation = {
        kind: 'put_task',
        controlId: c.controlId,
        task: {
          sessionId: c.controlSessionId,
          status: 'inactive',
          record: {
            id: randomUUID(),
            kind: 'at',
            title: 'AllRice once control',
            prompt,
            scheduledAt: c.at,
          },
          lastDelivery: delivery,
          deliveryHistory: {
            records: [{ ...delivery, prompt }],
            earlierRecordsUnavailable: false,
          },
        },
      };
      return { id: task.id, write: write(mutation) };
    }
    const runs = (id: string) =>
      f.db`select run_id from allrice_automation_runs where automation_id=${id}`;
    async function oneRun(id: string) {
      await vi.waitFor(async () => expect(await runs(id)).toHaveLength(1), {
        timeout: 5_000,
        interval: 20,
      });
      const rows =
        await f.db`select outbox_state from allrice_native_once_occurrences where automation_id=${id}`;
      expect(rows).toEqual([{ outbox_state: 'enqueued' }]);
    }
    function loop(canRun = () => true, beforeDispatch = async () => {}) {
      const errors: unknown[] = [];
      const tick = createCoalescedTick(async () => {
        try {
          await beforeDispatch();
          while (await dispatchNextNativeOnceOccurrence(workerId)) {
            /* bounded by this test's receipts */
          }
        } catch (error) {
          errors.push(error);
        }
      }, canRun);
      return { tick, errors };
    }

    it('leaves an unready wake durable and dispatches on the next ready one-second tick', async () => {
      const r = await reminder();
      let ready = false;
      const { tick, errors } = loop(() => ready);
      const wake = vi.fn(() => tick.request());
      expect(
        await wakeOnDelivery(port, wake).commitMutation(writer, r.write),
      ).toBe('committed');
      expect(wake).toHaveBeenCalledOnce();
      expect(tick.current()).toBeNull();
      expect(await runs(r.id)).toHaveLength(0);
      const poll = setInterval(() => {
        void tick.tick();
      }, 1_000);
      try {
        ready = true;
        await oneRun(r.id);
        await tick.current();
        expect(errors).toEqual([]);
      } finally {
        ready = false;
        clearInterval(poll);
        await tick.current();
      }
    });

    it('replaying the same receipt and exact write wakes again but never creates a second Run', async () => {
      const r = await reminder();
      const { tick, errors } = loop();
      const wake = vi.fn(() => tick.request());
      const wrapped = wakeOnDelivery(port, wake);
      for (const w of [
        r.write,
        r.write,
        { ...r.write, writeId: randomUUID() },
      ]) {
        expect(await wrapped.commitMutation(writer, w)).toBe('committed');
        await tick.current();
      }
      await oneRun(r.id);
      expect(wake).toHaveBeenCalledTimes(3);
      expect(errors).toEqual([]);
    });

    it('a lost COMMIT acknowledgement wakes once exact readback proves the delivery, with no poll', async () => {
      const r = await reminder();
      const { tick, errors } = loop();
      const wake = vi.fn(() => tick.request());
      const lostAck: NativeScheduleOnceStore = {
        ...port,
        async commitMutation(w, value) {
          await port.commitMutation(w, value);
          throw new Error('injected lost COMMIT acknowledgement');
        },
      };
      const wrapped = wakeOnDelivery(lostAck, wake);
      await expect(wrapped.commitMutation(writer, r.write)).rejects.toThrow(
        'lost COMMIT',
      );
      expect(wake).not.toHaveBeenCalled();
      // The controller proves the write by exact readback; that is the delivery.
      expect(await wrapped.readExactCommit(writer, r.write)).toBe('committed');
      expect(wake).toHaveBeenCalledOnce();
      await oneRun(r.id);
      await tick.current();
      expect(errors).toEqual([]);
    });

    it('a failed dispatch attempt can recover on the one-second poll without another delivery', async () => {
      const r = await reminder();
      const dispatchGate = vi
        .fn(async () => {})
        .mockRejectedValueOnce(new Error('injected database outage'));
      const { tick, errors } = loop(() => true, dispatchGate);
      expect(
        await wakeOnDelivery(port, () => tick.request()).commitMutation(
          writer,
          r.write,
        ),
      ).toBe('committed');
      await tick.current();
      expect(errors).toHaveLength(1);
      expect(await runs(r.id)).toHaveLength(0);
      const poll = setInterval(() => {
        void tick.tick();
      }, 1_000);
      try {
        await oneRun(r.id);
        await tick.current();
      } finally {
        clearInterval(poll);
        await tick.current();
      }
      expect(errors).toHaveLength(1);
    });

    it('shutdown drains an in-flight commit, suppresses its queued wake, and leaves one recoverable receipt', async () => {
      const r = await reminder();
      const releaseTick = deferred(),
        releaseCommit = deferred(),
        committing = deferred();
      let stopping = false;
      const scan = vi.fn(async () => {
        await releaseTick.promise;
      });
      const tick = createCoalescedTick(scan, () => !stopping);
      void tick.tick();
      const wrapped = wakeOnDelivery(
        {
          ...port,
          async commitMutation(w, value) {
            committing.resolve();
            await releaseCommit.promise;
            return port.commitMutation(w, value);
          },
        },
        () => tick.request(),
      );
      const writing = wrapped.commitMutation(writer, r.write);
      await committing.promise;
      stopping = true; // Same synchronous admission fence used by the SIGTERM handler.
      const closed = vi.fn(async () => {});
      const noop = async () => {};
      const closing = closeWorkerResources({
        drainTasks: [
          { name: 'automation', run: () => tick.current() },
          { name: 'native_control', run: () => writing },
        ],
        waitForProducerRoots: noop,
        stopCloudProjects: noop,
        closeHarness: noop,
        waitForInventory: noop,
        verifyRuntimeClosure: noop,
        removeCapabilities: noop,
        closeDatabase: closed,
      });
      try {
        expect(closed).not.toHaveBeenCalled();
        releaseCommit.resolve();
        expect(await writing).toBe('committed');
        releaseTick.resolve();
        await closing;
        expect(closed).toHaveBeenCalledOnce();
        expect(scan).toHaveBeenCalledOnce();
        expect(tick.current()).toBeNull();
        expect(await runs(r.id)).toHaveLength(0);
        expect(
          await f.db`select outbox_state from allrice_native_once_occurrences where automation_id=${r.id}`,
        ).toEqual([{ outbox_state: 'pending' }]);
        const restarted = loop();
        await restarted.tick.tick();
        await restarted.tick.tick();
        await oneRun(r.id);
        expect(restarted.errors).toEqual([]);
      } finally {
        releaseCommit.resolve();
        releaseTick.resolve();
        await closing;
      }
    });
  },
);
