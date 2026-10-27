import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
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
import {
  claimNextJob,
  enqueueRun,
  failJob,
  maintainQueue,
  startClaimedJob,
} from '../../../../packages/database/src/execution/queue.ts';
import { releaseNextConversationFollowup } from '../../../../packages/database/src/conversation/queued-messages.ts';
import {
  listenForReadyJobs,
  probeReadyJobs,
} from '../../../../packages/database/src/execution/queue-ready.ts';
import {
  createCoalescedTick,
  startQueueWakeups,
} from '../../src/queue-wakeup.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;

/** User view: a sent message, a reminder that has come due and a run scheduled
 * two seconds ahead are each claimed within a second, by a Worker loop that
 * has no interval poll at all, only the production LISTEN/NOTIFY wakeups. The
 * reminder goes through the real product API and once dispatch, as in the
 * MET-219 claim suite. Timings are read back from the persisted job rows. */
suite(
  'claiming queued work on a PostgreSQL wakeup instead of the poll (MET-223)',
  { timeout: 60_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let root: string;
    let store: ReturnType<typeof createNativeOnceSqlStore>;
    let writer: NativeOnceWriter;
    let wakeups: ReturnType<typeof startQueueWakeups> | undefined;
    const workerId = randomUUID();
    const claimed = new Map<string, { attempt: number; lease: string }>();
    const claims: { id: string; worker: string }[] = [];
    let tickCount = 0;
    // The production tick body minus the memory gate and execution start.
    const ticks = createCoalescedTick(
      async () => {
        tickCount++;
        await maintainQueue();
        for (;;) {
          // Long enough that no earlier claim expires and is requeued mid-suite.
          const job = await claimNextJob(workerId, 300_000);
          if (!job) return;
          claims.push({ id: job.id, worker: workerId });
          claimed.set(job.id, {
            attempt: job.attempt,
            lease: job.lease!.token,
          });
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
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      root = await realpath(await mkdtemp(join(tmpdir(), 'allrice-wakeup-')));
      const reference = {
        artifactId: `sha256:${'e'.repeat(64)}`,
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
      await f.db`update allrice_jobs set status='canceled' where status='queued'`;
    }, 120_000);
    afterAll(async () => {
      try {
        await wakeups?.stop();
        await ticks.current();
        await f?.close();
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }, 30_000);

    function startWorkerWakeups() {
      wakeups = startQueueWakeups({
        listen: listenForReadyJobs,
        probe: probeReadyJobs,
        wake: () => ticks.request(),
        log: { info: () => {}, warn: () => {} },
      });
    }
    async function claimedRow(jobId: string, attempt = 1) {
      await vi.waitFor(
        () => expect(claimed.get(jobId)?.attempt).toBe(attempt),
        { timeout: 5_000, interval: 10 },
      );
      const [row] = await f.db<
        {
          status: string;
          worker_id: string;
          created_ms: number;
          available_ms: number;
          claimed_ms: number;
        }[]
      >`select status,worker_id,
          (extract(epoch from created_at)*1000)::float8 as created_ms,
          (extract(epoch from available_at)*1000)::float8 as available_ms,
          (extract(epoch from claimed_at)*1000)::float8 as claimed_ms
        from allrice_jobs where id=${jobId}`;
      expect(row).toMatchObject({ status: 'claimed', worker_id: workerId });
      return row!;
    }
    async function sendMessage(text: string, sessionId?: string) {
      const session = sessionId
        ? { id: sessionId }
        : await createChatSession(f.context, {
            workspaceId: f.workspaceId,
            employeeAssignmentId: f.assignmentId,
            title: text,
          });
      const sent = await sendChatMessage(f.context, f.workspaceId, session.id, {
        clientMessageId: randomUUID(),
        text,
        deliveryMode: 'follow_up',
      });
      return sent.run.job.id;
    }
    async function mutate(mutation: NativeOnceMutation) {
      expect(await store.renewWriter(writer)).not.toBeNull();
      expect(
        await store.commitMutation(writer, {
          writeId: randomUUID(),
          digest: nativeOnceDigest(mutation),
          mutation,
        }),
      ).toBe('committed');
    }
    const databaseNow = async () =>
      (
        await f.db<{ now: Date }[]>`select clock_timestamp() as now`
      )[0]!.now.getTime();
    /** "提醒我…" via the product API, the native timer's delivery receipt at
     * the due time, then the real dispatch that queues the reminder's Run. */
    async function dueReminder(prompt: string) {
      const session = await createChatSession(f.context, {
        workspaceId: f.workspaceId,
        employeeAssignmentId: f.assignmentId,
        title: '客户回电',
      });
      const task = await createOnceTask(f.context, session.id, {
        clientRequestId: randomUUID(),
        name: '回电提醒',
        prompt,
        runAt: new Date((await databaseNow()) + 7_000).toISOString(),
        timezone: 'Asia/Shanghai',
      });
      const [row] = await f.db<
        { snapshot: { control: NativeOnceControl } }[]
      >`select snapshot from allrice_native_once_controls where automation_id=${task.id}`;
      const c = row!.snapshot.control;
      const dueInMs = Date.parse(c.at) - (await databaseNow()) + 20;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueInMs)));
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
      const [job] = await f.db<{ id: string }[]>`
        select j.id from allrice_automation_runs ar
        join allrice_jobs j on j.run_id=ar.run_id where ar.automation_id=${task.id}`;
      return job!.id;
    }

    it('claims a message sent while the Worker was down as soon as it subscribes', async () => {
      const jobId = await sendMessage('帮我把昨天的销售数据汇总一下');
      expect(claimed.has(jobId)).toBe(false);
      startWorkerWakeups();
      await claimedRow(jobId);
      expect(wakeups!.status()).toMatchObject({ state: 'listening' });
    });

    it('claims a sent message within a second of it being queued', async () => {
      const jobId = await sendMessage('帮我把今天的会议纪要整理成三条要点');
      const row = await claimedRow(jobId);
      expect(row.claimed_ms - row.created_ms).toBeLessThan(1_000);
    });

    it('claims a due reminder within a second of its dispatch', async () => {
      const jobId = await dueReminder('提醒我下午给客户回电话，确认合同细节');
      const row = await claimedRow(jobId);
      expect(row.claimed_ms - row.available_ms).toBeLessThan(1_000);
    });

    it('claims a run scheduled two seconds ahead at its time, not before', async () => {
      const availableAt = new Date((await databaseNow()) + 2_000);
      const queued = await enqueueRun(f.context, {
        workspaceId: f.workspaceId,
        type: 'allrice.system.echo',
        input: {},
        idempotencyKey: randomUUID(),
        availableAt: availableAt.toISOString(),
      });
      const row = await claimedRow(queued.run.job.id);
      expect(row.available_ms).toBe(availableAt.getTime());
      expect(row.claimed_ms).toBeGreaterThanOrEqual(row.available_ms);
      expect(row.claimed_ms - row.available_ms).toBeLessThan(1_000);
    });

    it('starts a queued follow-up message as soon as the previous turn releases it', async () => {
      const first = await sendMessage('先帮我列一下本周待办');
      await claimedRow(first);
      const [bound] = await f.db<{ session_id: string }[]>`
        select e.session_id from allrice_employee_runs e
        join allrice_jobs j on j.run_id=e.run_id where j.id=${first}`;
      const sessionId = bound!.session_id;
      const next = await sendMessage('再按优先级排个序', sessionId);
      const [queued] = await f.db<{ waiting_ms: number }[]>`
        select (extract(epoch from available_at-clock_timestamp())*1000)::float8 as waiting_ms
        from allrice_jobs where id=${next}`;
      expect(queued!.waiting_ms).toBeGreaterThan(60 * 60_000);
      // The first turn ends (outside this suite's scope), then the native
      // turn-completion path releases the queue head under the runtime lock.
      await f.db`update allrice_jobs set status='succeeded' where id=${first}`;
      await f.db`update allrice_runs set state='succeeded'
        where id=(select run_id from allrice_jobs where id=${first})`;
      await f.db.begin((tx) => releaseNextConversationFollowup(tx, sessionId));
      const row = await claimedRow(next);
      expect(row.claimed_ms - row.available_ms).toBeLessThan(1_000);
    });

    it('reclaims a retryable failure when its backoff ends, not on a later poll', async () => {
      const queued = await enqueueRun(f.context, {
        workspaceId: f.workspaceId,
        type: 'allrice.system.echo',
        input: {},
        idempotencyKey: randomUUID(),
      });
      const jobId = queued.run.job.id;
      await claimedRow(jobId);
      const { lease } = claimed.get(jobId)!;
      expect(await startClaimedJob(workerId, jobId, lease)).not.toBeNull();
      expect(
        await failJob({
          workerId,
          jobId,
          leaseToken: lease,
          code: 'PROVIDER_UNAVAILABLE',
          message: '模型服务暂时不可用',
          retryable: true,
          retryBaseMs: 1_000,
        }),
      ).toMatchObject({ retrying: true });
      const row = await claimedRow(jobId, 2);
      expect(row.claimed_ms).toBeGreaterThanOrEqual(row.available_ms);
      expect(row.claimed_ms - row.available_ms).toBeLessThan(1_000);
    });

    it('resubscribes after its connection is killed and keeps claiming promptly', async () => {
      const before = wakeups!.status();
      expect(before.pid).not.toBeNull();
      await f.db`select pg_terminate_backend(${before.pid})`;
      await vi.waitFor(
        () =>
          expect(wakeups!.status().wakes.listen).toBe(before.wakes.listen + 1),
        { timeout: 5_000, interval: 10 },
      );
      expect(wakeups!.status().pid).not.toBe(before.pid);
      const jobId = await sendMessage('把这周的周报草稿发我看看');
      const row = await claimedRow(jobId);
      expect(row.claimed_ms - row.created_ms).toBeLessThan(1_000);
    });

    it('two listeners drain a burst of 48 jobs once each without a tick storm', async () => {
      const otherWorker = randomUUID();
      let otherTicks = 0;
      const loop = createCoalescedTick(
        async () => {
          otherTicks++;
          await maintainQueue();
          for (;;) {
            const job = await claimNextJob(otherWorker, 300_000);
            if (!job) return;
            claims.push({ id: job.id, worker: otherWorker });
          }
        },
        () => true,
      );
      const other = startQueueWakeups({
        listen: listenForReadyJobs,
        probe: probeReadyJobs,
        wake: () => loop.request(),
        log: { info() {}, warn() {} },
      });
      try {
        await vi.waitFor(() => expect(other.status().state).toBe('listening'));
        await loop.current();
        await ticks.current();
        const before = tickCount + otherTicks;
        const jobs = await Promise.all(
          Array.from({ length: 48 }, (_, i) =>
            enqueueRun(f.context, {
              workspaceId: f.workspaceId,
              type: 'allrice.system.echo',
              input: { i },
              idempotencyKey: randomUUID(),
            }),
          ),
        );
        const ids = new Set(jobs.map((j) => j.run.job.id));
        await vi.waitFor(
          () => expect(claims.filter((c) => ids.has(c.id))).toHaveLength(48),
          { timeout: 10_000, interval: 10 },
        );
        await ticks.current();
        await loop.current();
        const taken = claims.filter((c) => ids.has(c.id));
        expect(new Set(taken.map((c) => c.id)).size).toBe(48);
        expect(new Set(taken.map((c) => c.worker)).size).toBe(2);
        const rows =
          await f.db`select attempt,status,extract(epoch from (claimed_at-available_at))*1000 as delay_ms
          from allrice_jobs where id in ${f.db([...ids])}`;
        expect(
          rows.every((r) => r.attempt === 1 && r.status === 'claimed'),
        ).toBe(true);
        const ms = rows.map((r) => Number(r.delay_ms)).sort((a, b) => a - b);
        const delta = tickCount + otherTicks - before;
        expect(ms.at(-1)).toBeLessThan(1_000);
        expect(delta).toBeLessThanOrEqual(2 * (48 + 2));
      } finally {
        await other.stop();
        await loop.current();
      }
    });

    it('promotes and claims a retry at its announced deadline with no polling timer', async () => {
      const queued = await enqueueRun(f.context, {
        workspaceId: f.workspaceId,
        type: 'allrice.system.echo',
        input: {},
        idempotencyKey: randomUUID(),
      });
      const id = queued.run.job.id;
      await claimedRow(id);
      const [lease] =
        await f.db`select lease_token from allrice_jobs where id=${id}`;
      expect(
        await startClaimedJob(workerId, id, lease!.lease_token),
      ).not.toBeNull();
      expect(
        await failJob({
          workerId,
          jobId: id,
          leaseToken: lease!.lease_token,
          code: 'TEST_TRANSIENT',
          message: 'synthetic retry',
          retryable: true,
          retryBaseMs: 1_000,
        }),
      ).toMatchObject({ retrying: true });
      const [scheduled] =
        await f.db`select status,available_at from allrice_jobs where id=${id}`;
      expect(scheduled!.status).toBe('retry_wait');
      await vi.waitFor(
        async () => {
          const [r] =
            await f.db`select status,attempt,claimed_at from allrice_jobs where id=${id}`;
          expect(r!.status).toBe('claimed');
          expect(r!.attempt).toBe(2);
          const late =
            r!.claimed_at.getTime() - scheduled!.available_at.getTime();
          expect(late).toBeGreaterThanOrEqual(0);
          expect(late).toBeLessThan(1_000);
        },
        { timeout: 5_000, interval: 10 },
      );
      expect(claims.filter((c) => c.id === id)).toHaveLength(2);
    });

    it('rolls back an enqueue after pg_notify without delivering its unique payload', async () => {
      const received: string[] = [];
      const listener = await listenForReadyJobs(
        (payload) => received.push(payload),
        () => {},
      );
      const key = randomUUID();
      const at = new Date((await databaseNow()) + 123_456);
      // A deferred trigger fails at COMMIT, after enqueueRun has called the
      // real notify helper. The trigger and tables live only in this fixture.
      await f.db
        .unsafe(`create function met223_rollback_enqueue() returns trigger language plpgsql as $$
        begin raise exception 'MET223_FORCED_ROLLBACK'; end $$;
        create constraint trigger met223_rollback_enqueue after insert on allrice_jobs
        deferrable initially deferred for each row execute function met223_rollback_enqueue();`);
      try {
        await expect(
          enqueueRun(f.context, {
            workspaceId: f.workspaceId,
            type: 'allrice.system.echo',
            input: {},
            idempotencyKey: key,
            availableAt: at.toISOString(),
          }),
        ).rejects.toThrow('MET223_FORCED_ROLLBACK');
        const barrier = `probe:${randomUUID()}:rollback-barrier`;
        await probeReadyJobs(barrier);
        await vi.waitFor(() => expect(received).toContain(barrier));
        expect(received).not.toContain(String(at.getTime()));
        expect(
          await f.db`select id from allrice_jobs where idempotency_key=${key}`,
        ).toHaveLength(0);
      } finally {
        await f.db.unsafe(
          'drop trigger met223_rollback_enqueue on allrice_jobs; drop function met223_rollback_enqueue()',
        );
        await listener.close();
      }
    });

    it('rejects a missing DATABASE_URL and closes the dedicated backend on stop', async () => {
      const original = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        await expect(
          listenForReadyJobs(
            () => {},
            () => {},
          ),
        ).rejects.toThrow('DATABASE_URL is required');
      } finally {
        process.env.DATABASE_URL = original;
      }
      const pid = wakeups!.status().pid;
      await wakeups!.stop();
      await ticks.current();
      expect(wakeups!.status()).toMatchObject({ state: 'stopped', pid: null });
      await vi.waitFor(async () =>
        expect(
          await f.db`select pid from pg_stat_activity where pid=${pid}`,
        ).toHaveLength(0),
      );
    });

    it('sweeps notifications lost during a transport outage and stops during reconnection', async () => {
      // Interrupt only this test's LISTEN transport, never the Postgres server.
      const target = new URL(process.env.DATABASE_URL!);
      const sockets = new Set<Socket>();
      let blocked = false;
      const proxy = createServer((client) => {
        if (blocked) return void client.destroy();
        const upstream = connect(Number(target.port || 5432), target.hostname);
        for (const socket of [client, upstream]) {
          sockets.add(socket);
          socket.on('error', () => {
            client.destroy();
            upstream.destroy();
          });
          socket.on('close', () => {
            sockets.delete(socket);
            client.destroy();
            upstream.destroy();
          });
        }
        client.pipe(upstream).pipe(client);
      });
      await new Promise<void>((resolve) =>
        proxy.listen(0, '127.0.0.1', resolve),
      );
      const address = proxy.address();
      expect(address && typeof address !== 'string').toBe(true);
      const proxyUrl = new URL(target);
      proxyUrl.hostname = '127.0.0.1';
      proxyUrl.port = String((address as { port: number }).port);
      wakeups = startQueueWakeups({
        listen: (onReady, onListen, options) => {
          const original = process.env.DATABASE_URL;
          process.env.DATABASE_URL = proxyUrl.toString();
          try {
            return listenForReadyJobs(onReady, onListen, options);
          } finally {
            process.env.DATABASE_URL = original;
          }
        },
        probe: probeReadyJobs,
        wake: () => ticks.request(),
        probeIntervalMs: 100,
        probeTimeoutMs: 60,
        log: { info() {}, warn() {} },
      });
      try {
        await vi.waitFor(() =>
          expect(wakeups!.status().state).toBe('listening'),
        );
        await ticks.current();
        const before = wakeups.status();
        blocked = true;
        for (const socket of sockets) socket.destroy();
        await vi.waitFor(async () =>
          expect(
            await f.db`select pid from pg_stat_activity where pid=${before.pid}`,
          ).toHaveLength(0),
        );
        const queued = await enqueueRun(f.context, {
          workspaceId: f.workspaceId,
          type: 'allrice.system.echo',
          input: {},
          idempotencyKey: randomUUID(),
        });
        expect(claimed.has(queued.run.job.id)).toBe(false);
        blocked = false;
        await vi.waitFor(
          () =>
            expect(wakeups!.status().wakes.listen).toBeGreaterThan(
              before.wakes.listen,
            ),
          { timeout: 5_000 },
        );
        await claimedRow(queued.run.job.id);
        expect(wakeups.status().pid).not.toBe(before.pid);
        // Force a second reconnect, then stop while the transport is unavailable.
        const lastPid = wakeups.status().pid;
        blocked = true;
        for (const socket of sockets) socket.destroy();
        await wakeups.stop();
        expect(wakeups.status().state).toBe('stopped');
        await vi.waitFor(async () =>
          expect(
            await f.db`select pid from pg_stat_activity where pid=${lastPid}`,
          ).toHaveLength(0),
        );
      } finally {
        await wakeups.stop();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          proxy.close((error) => (error ? reject(error) : resolve())),
        );
        await ticks.current();
      }
    });
  },
);
