import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { createChatSession } from '../../../../packages/database/src/workspace/service.ts';
import {
  createOnceTask,
  initializeNativeOncePartition,
} from '../../../../packages/database/src/native-schedule-once-product.ts';
import {
  createRecurringTask,
  initializeNativeRecurringPartition,
} from '../../../../packages/database/src/native-schedule-recurring-product.ts';
import {
  claimNextJob,
  startClaimedJob,
} from '../../../../packages/database/src/execution/queue.ts';
import {
  listenForReadyJobs,
  probeReadyJobs,
} from '../../../../packages/database/src/execution/queue-ready.ts';
import { measureDshNativeArtifact } from '../../src/harness/dsh-native-artifact.ts';
import {
  createNativeOnceControlSource,
  createNativeOnceWorkerService,
} from '../../src/native-schedule-once-loader.ts';
import {
  createCoalescedTick,
  startQueueWakeups,
} from '../../src/queue-wakeup.ts';

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
async function within(promise: Promise<void>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          25_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Real DSH timer -> loader/service/runtime -> SQL outbox -> NOTIFY -> claim/start.
// This deliberately does NOT claim to launch index.ts, exercise a real model,
// measure two revisions, or test /health/ready. Those need a QA instance.
suite(
  'MET-223 real timer delivery and dispatch components',
  { timeout: 60_000 },
  () => {
    let f: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
    let stateRoot: string, recurringRoot: string;
    let source: ReturnType<typeof createNativeOnceControlSource>;
    let recurringSource: ReturnType<typeof createNativeOnceControlSource>;
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      f = await createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      stateRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'met223-real-timer-')),
      );
      const root = await realpath(
        fileURLToPath(new URL('../../../../', import.meta.url)),
      );
      const measured = await measureDshNativeArtifact(root);
      const reference = {
        artifactId: measured.artifactId,
        profileId: 'allrice-once-control-v1',
        storageId: 'isolated-met223-real-timer',
        stateRoot,
      };
      vi.stubEnv('ALLRICE_NATIVE_ONCE_REFERENCE', JSON.stringify(reference));
      const ports = {
        currentArtifact: () => ({
          artifactId: measured.artifactId,
          generation: measured.content.generation,
          root,
          content: measured.content,
        }),
      };
      source = createNativeOnceControlSource(reference, ports);
      await initializeNativeOncePartition(reference);
      recurringRoot = await realpath(
        await mkdtemp(join(tmpdir(), 'met223-recurring-timer-')),
      );
      const recurringReference = {
        ...reference,
        profileId: 'allrice-recurring-control-v1',
        storageId: 'isolated-met223-recurring',
        stateRoot: recurringRoot,
      };
      vi.stubEnv(
        'ALLRICE_NATIVE_RECURRING_REFERENCE',
        JSON.stringify(recurringReference),
      );
      recurringSource = createNativeOnceControlSource(
        recurringReference,
        ports,
      );
      await initializeNativeRecurringPartition(recurringReference);
    }, 120_000);
    afterAll(async () => {
      try {
        const cleanup = await f?.close();
        if (cleanup) expect(cleanup.fixture?.schemaRemoved).toBe(true);
        if (stateRoot) await rm(stateRoot, { recursive: true, force: true });
        if (recurringRoot)
          await rm(recurringRoot, { recursive: true, force: true });
      } finally {
        vi.unstubAllEnvs();
      }
    }, 30_000);

    it.each([
      'poll-only',
      'delivery',
      'busy-tick',
      'throwing-callback',
      'cold-resume',
      'recurring',
    ] as const)(
      '%s starts each real reminder once and counts committed deliveries',
      async (mode) => {
        const workerId = randomUUID();
        const release = deferred(),
          passedConsumer = deferred(),
          delivered = deferred();
        let stopping = false,
          holdAfterConsumer = false,
          tickCount = 0,
          callbacks = 0;
        const errors: unknown[] = [];
        const automation = createCoalescedTick(
          async () => {
            tickCount++;
            try {
              await service.tick();
              if (holdAfterConsumer) {
                holdAfterConsumer = false;
                passedConsumer.resolve();
                await release.promise;
              }
            } catch (error) {
              errors.push(error);
            }
          },
          () => !stopping,
        );
        const makeService = () =>
          createNativeOnceWorkerService({
            workerId,
            source: mode === 'recurring' ? recurringSource : source,
            readMaintenance: async () => null,
            ...(mode === 'poll-only'
              ? {}
              : {
                  onDelivery: () => {
                    callbacks++;
                    delivered.resolve();
                    if (mode === 'throwing-callback')
                      throw new Error('injected wake failure');
                    automation.request();
                  },
                }),
          });
        let service = makeService();
        const queue = createCoalescedTick(
          async () => {
            try {
              for (;;) {
                const job = await claimNextJob(workerId, 300_000);
                if (!job) return;
                await startClaimedJob(workerId, job.id, job.lease!.token);
              }
            } catch (error) {
              errors.push(error);
            }
          },
          () => !stopping,
        );
        let poll: ReturnType<typeof setInterval> | undefined;
        const wakeups = startQueueWakeups({
          listen: listenForReadyJobs,
          probe: probeReadyJobs,
          wake: () => queue.request(),
          log: { info: () => {}, warn: () => {} },
        });
        try {
          await vi.waitFor(() =>
            expect(wakeups.status().state).toBe('listening'),
          );
          const ids: string[] = [];
          const sampleCount =
            mode === 'poll-only' || mode === 'delivery' ? 3 : 1;
          const [clock] = await f.db<
            { now: Date }[]
          >`select clock_timestamp() as now`;
          for (let i = 0; i < sampleCount; i++) {
            const session = await createChatSession(f.context, {
              workspaceId: f.workspaceId,
              employeeAssignmentId: f.assignmentId,
              title: `MET-223 ${mode} ${i}`,
            });
            const input = {
              clientRequestId: randomUUID(),
              name: '客户回电提醒',
              prompt: '提醒我给客户回电话，确认合同细节',
            };
            const task =
              mode === 'recurring'
                ? await createRecurringTask(f.context, session.id, {
                    ...input,
                    rule: {
                      kind: 'daily',
                      time: new Date(clock!.now.getTime() + 10_000)
                        .toISOString()
                        .slice(11, 19),
                      timezone: 'UTC',
                    },
                  })
                : await createOnceTask(f.context, session.id, {
                    ...input,
                    runAt: new Date(
                      clock!.now.getTime() + 10_000 + 333 * i,
                    ).toISOString(),
                    timezone: 'Asia/Shanghai',
                  });
            ids.push(task.id);
          }
          await automation.tick(); // Boots the actual Host and arms the timers.
          expect(service.status()).toMatchObject({
            state: 'active',
            deliveryWakeRequests: 0,
          });
          const native =
            mode === 'recurring'
              ? await f.db`select native_task_id from allrice_native_recurring_controls where automation_id in ${f.db(ids)}`
              : await f.db`select native_task_id from allrice_native_once_controls where automation_id in ${f.db(ids)}`;
          expect(native).toHaveLength(sampleCount);
          expect(
            native.every((row) => typeof row.native_task_id === 'string'),
          ).toBe(true);
          if (mode === 'cold-resume') {
            await service.stop();
            expect(service.status().state).toBe('closed');
            service = makeService();
            await automation.tick();
            expect(
              await f.db`select native_task_id from allrice_native_once_controls where automation_id in ${f.db(ids)}`,
            ).toEqual(native);
            expect(service.status()).toMatchObject({
              state: 'active',
              deliveryWakeRequests: 0,
            });
          }
          if (mode === 'poll-only' || mode === 'throwing-callback') {
            poll = setInterval(() => {
              void automation.tick();
            }, 1_000);
          }
          if (mode === 'busy-tick') {
            holdAfterConsumer = true;
            void automation.tick();
            // Reject inside the test body so its finally block still drains the
            // Host if a regression prevents the consumer or delivery from firing.
            await within(passedConsumer.promise, 'the initial consumer');
            await within(delivered.promise, 'the real timer delivery');
            // The consumer already ran. Only the coalesced follow-up can see the receipt.
            expect(
              await f.db`select run_id from allrice_automation_runs where automation_id in ${f.db(ids)}`,
            ).toHaveLength(0);
            expect(tickCount).toBe(2);
            release.resolve();
          }
          // Let the actual timer reach its due time before querying for a Run.
          // Avoid ten seconds of unnecessary SQL polling on a shared test host.
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.max(0, clock!.now.getTime() + 10_000 - Date.now()),
            ),
          );
          const rows = await vi.waitFor(
            async () => {
              const result = await f.db<
                {
                  automation_id: string;
                  delay_ms: number | null;
                  due_to_receipt_ms: number;
                  receipt_to_start_ms: number | null;
                  started_count: number;
                }[]
              >`
            select ar.automation_id,
              (extract(epoch from (timing.started_at - ar.scheduled_for))*1000)::float8 as delay_ms,
              (extract(epoch from (timing.receipt_at - ar.scheduled_for))*1000)::float8 as due_to_receipt_ms,
              (extract(epoch from (timing.started_at - timing.receipt_at))*1000)::float8 as receipt_to_start_ms,
              (select count(*)::int from allrice_run_events e where e.run_id=ar.run_id and e.event_type='run.started') as started_count
            from allrice_automation_runs ar
            left join allrice_native_once_occurrences once_o on once_o.occurrence_id=ar.native_once_occurrence_id
            left join allrice_native_recurring_occurrences recurring_o on recurring_o.occurrence_id=ar.native_recurring_occurrence_id
            cross join lateral (select
              (coalesce(once_o.payload,recurring_o.payload)#>>'{receipt,deliveredAt}')::timestamptz as receipt_at,
              (select min(e.occurred_at) from allrice_run_events e where e.run_id=ar.run_id and e.event_type='run.started') as started_at) timing
            where ar.automation_id in ${f.db(ids)} order by ar.scheduled_for`;
              expect(result).toHaveLength(sampleCount);
              expect(result.every((r) => r.delay_ms !== null)).toBe(true);
              return result;
            },
            { timeout: 25_000, interval: 50 },
          );
          expect(errors).toEqual([]);
          expect(
            rows.every((r) => r.started_count === 1 && r.delay_ms! >= 0),
          ).toBe(true);
          expect(service.status()).toMatchObject({
            deliveryWakeRequests: sampleCount,
            deliveryWakeFailures:
              mode === 'throwing-callback' ? sampleCount : 0,
            processedCount: sampleCount,
          });
          expect(callbacks).toBe(mode === 'poll-only' ? 0 : sampleCount);
          if (mode === 'busy-tick') expect(tickCount).toBe(3);
          // A further ordinary tick must not duplicate any of these runs.
          if (poll) clearInterval(poll);
          await automation.current();
          await automation.tick();
          expect(
            await f.db`select run_id from allrice_automation_runs where automation_id in ${f.db(ids)}`,
          ).toHaveLength(sampleCount);
        } finally {
          stopping = true;
          release.resolve();
          if (poll) clearInterval(poll);
          await wakeups.stop();
          await Promise.all([
            service.stop(),
            automation.current(),
            queue.current(),
          ]);
          expect(service.status().state).toBe('closed');
        }
      },
    );
  },
);
