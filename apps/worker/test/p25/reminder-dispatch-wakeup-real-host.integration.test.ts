import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type TestContext,
} from 'vitest';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import {
  createFailureCleanup,
  createFailureEvidence,
} from '../../../../scripts/test-failure-evidence.mjs';
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
import type { NativeScheduleOnceStore } from '../../src/native-schedule-once.ts';
import {
  createNativeOnceWorkerRuntime,
  type NativeOnceWorkerDatabasePorts,
} from '../../src/native-schedule-once-runtime.ts';
import {
  createCoalescedTick,
  startQueueWakeups,
} from '../../src/queue-wakeup.ts';

const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
type ObservedStore = Pick<
  NativeScheduleOnceStore,
  'commitMutation' | 'readExactCommit'
>;
function writeError(
  error: unknown,
  seen = new Set<object>(),
  depth = 0,
): unknown {
  if (!error || typeof error !== 'object') return error;
  if (seen.has(error)) return { circular: true };
  if (depth === 8) return { truncated: true };
  seen.add(error);
  const value = error as {
    name?: string;
    message?: string;
    code?: string;
    stack?: string;
    cause?: unknown;
  };
  return {
    name: value.name,
    message: value.message,
    code: value.code,
    stack: value.stack,
    cause: writeError(value.cause, seen, depth + 1),
  };
}
function observeControlWrites(
  store: ObservedStore,
  evidence: Pick<ReturnType<typeof createFailureEvidence>, 'mark'>,
): ObservedStore {
  const observe =
    <Result>(
      operation: keyof ObservedStore,
      run: (
        ...args: Parameters<ObservedStore['commitMutation']>
      ) => Promise<Result>,
    ) =>
    (...args: Parameters<ObservedStore['commitMutation']>) => {
      const [writer, write] = args;
      const mark = (
        phase: string,
        outcome: { result?: unknown; error?: unknown } = {},
      ) => {
        try {
          evidence.mark(phase, {
            operation,
            writer: {
              partitionId: writer.partitionId,
              ownerId: writer.ownerId,
              epoch: writer.epoch,
            },
            writeId: write.writeId,
            digest: write.digest,
            controlId:
              'controlId' in write.mutation
                ? write.mutation.controlId
                : undefined,
            mutation: structuredClone(write.mutation),
            ...('error' in outcome
              ? { error: writeError(outcome.error) }
              : outcome),
          });
        } catch {
          /* Observation must not change a write or reject its then callback. */
        }
      };
      mark('native-write-start');
      try {
        const pending = run(...args);
        void pending.then(
          (result) => mark('native-write-result', { result }),
          (error: unknown) => mark('native-write-error', { error }),
        );
        return pending;
      } catch (error) {
        mark('native-write-error', { error });
        throw error;
      }
    };
  return {
    commitMutation: observe('commitMutation', store.commitMutation.bind(store)),
    // The real SQL store may return unknown after catching an internal error;
    // only this exact result is visible here, not that hidden error's SQLSTATE.
    readExactCommit: observe(
      'readExactCommit',
      store.readExactCommit.bind(store),
    ),
  };
}
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
    let root: string;
    let measured: Awaited<ReturnType<typeof measureDshNativeArtifact>>;
    let predecessor: { test: string; finished: Promise<void> } | undefined;
    const localState = (task: TestContext['task']) => {
      const state: {
        f?: Awaited<ReturnType<typeof createP27CodexWorkerFixture>>;
        fixtureStarted?: boolean;
        stateRoot?: string;
        recurringRoot?: string;
        source?: ReturnType<typeof createNativeOnceControlSource>;
        recurringSource?: ReturnType<typeof createNativeOnceControlSource>;
        directory?: string;
        observe?: () => unknown;
        closeResults: unknown[];
      } = { closeResults: [] };
      const evidence = createFailureEvidence({
        file: import.meta.url,
        test: task.name,
        collect: async () => {
          const tables: Record<string, unknown> = Object.fromEntries(
            [
              'allrice_native_once_partitions',
              'allrice_native_once_close_proofs',
              'allrice_native_once_controls',
              'allrice_native_once_occurrences',
              'allrice_native_once_journal',
              'allrice_native_recurring_controls',
              'allrice_native_recurring_occurrences',
              'allrice_native_recurring_journal',
              'allrice_automation_runs',
              'allrice_runs',
              'allrice_jobs',
              'allrice_run_events',
            ].map((table) => [table, { state: 'pending' }]),
          );
          const snapshot = {
            schema: state.f?.schema,
            stateRoot: state.stateRoot,
            recurringRoot: state.recurringRoot,
            runtime: state.observe?.(),
            tables,
          };
          // This reference is serialized at the existing capture deadline even
          // when a slow table prevents collect() from returning its details.
          evidence.mark('failure-state', snapshot);
          const f = state.f;
          if (f)
            await Promise.all(
              Object.keys(tables).map(async (table) => {
                try {
                  const rows = await f.db`select * from ${f.db(table)}`;
                  tables[table] = {
                    state: 'complete',
                    rowCount: rows.length,
                    rows,
                  };
                } catch (error) {
                  tables[table] = { state: 'error', error };
                }
              }),
            );
          return snapshot;
        },
      });
      const capture = async (errors: unknown) =>
        (state.directory = await evidence.capture(errors));
      const cleanup = createFailureCleanup({ ...evidence, capture });
      let saving = Promise.resolve();
      const saveClose = () =>
        (saving = saving.then(async () => {
          if (!state.directory) return;
          try {
            // capture() memoizes pre-cleanup evidence; include late owners here too.
            await writeFile(
              join(state.directory, 'cleanup.json'),
              JSON.stringify(
                {
                  closeResults: state.closeResults,
                  runtime: state.observe?.(),
                },
                (_key, value) =>
                  value instanceof Error
                    ? {
                        ...value,
                        name: value.name,
                        message: value.message,
                        stack: value.stack,
                        cause: value.cause,
                      }
                    : value,
                2,
              ),
            );
          } catch (error) {
            console.error('TEST_FAILURE_CLEANUP_WRITE_FAILED', error);
          }
        }));
      const own = (resource: string, close: () => unknown | Promise<unknown>) =>
        cleanup.own(async () => {
          const entry: {
            resource: string;
            startedAt: string;
            endedAt?: string;
            result?: unknown;
            error?: unknown;
          } = { resource, startedAt: new Date().toISOString() };
          state.closeResults.push(entry);
          evidence.mark('close-start', { resource });
          await saveClose();
          try {
            entry.result = await close();
            evidence.mark('close-end', { resource, result: entry.result });
          } catch (error) {
            entry.error = error;
            await capture(error);
            throw error;
          } finally {
            entry.endedAt = new Date().toISOString();
            await saveClose();
          }
        });
      return { state, evidence, cleanup, own, saveClose, capture };
    };
    const locals = new WeakMap<
      TestContext['task'],
      ReturnType<typeof localState>
    >();
    beforeAll(async () => {
      vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
      vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
      vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
      root = await realpath(
        fileURLToPath(new URL('../../../../', import.meta.url)),
      );
      measured = await measureDshNativeArtifact(root);
    }, 120_000);
    beforeEach(async ({ task, onTestFailed }) => {
      const local = localState(task);
      locals.set(task, local);
      onTestFailed(async () => {
        await local.capture(task.result?.errors);
        await local.saveClose();
      });
      const { state, evidence, cleanup, own } = local;
      const previous = predecessor;
      if (previous) {
        evidence.mark('predecessor-cleanup', { test: previous.test });
        try {
          await previous.finished;
        } catch (error) {
          throw new Error(`Reminder cleanup unconfirmed: ${previous.test}`, {
            cause: error,
          });
        }
        cleanup.check();
      }
      evidence.mark('fixture-start');
      state.fixtureStarted = true;
      const pending = createP27CodexWorkerFixture({
        allowCiDatabase: true,
        personalProfile: 'writable',
      });
      own('fixture', async () => {
        const f = await pending;
        const cleanup = await f?.close();
        if (cleanup) expect(cleanup.fixture?.schemaRemoved).toBe(true);
        return cleanup;
      });
      const f = await pending;
      cleanup.check();
      state.f = f;
      for (const [key, prefix] of [
        ['stateRoot', 'met223-real-timer-'],
        ['recurringRoot', 'met223-recurring-timer-'],
      ] as const) {
        const directory = await mkdtemp(join(tmpdir(), prefix));
        const owner = own(key, () =>
          rm(directory, { recursive: true, force: true }),
        );
        if (owner.late) await owner.late;
        cleanup.check();
        state[key] = await realpath(directory);
        cleanup.check();
      }
      const reference = {
        artifactId: measured.artifactId,
        profileId: 'allrice-once-control-v1',
        storageId: 'isolated-met223-real-timer',
        stateRoot: state.stateRoot!,
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
      state.source = createNativeOnceControlSource(reference, ports);
      evidence.mark(
        'once-partition',
        await initializeNativeOncePartition(reference),
      );
      cleanup.check();
      const recurringReference = {
        ...reference,
        profileId: 'allrice-recurring-control-v1',
        storageId: 'isolated-met223-recurring',
        stateRoot: state.recurringRoot!,
      };
      vi.stubEnv(
        'ALLRICE_NATIVE_RECURRING_REFERENCE',
        JSON.stringify(recurringReference),
      );
      state.recurringSource = createNativeOnceControlSource(
        recurringReference,
        ports,
      );
      evidence.mark(
        'recurring-partition',
        await initializeNativeRecurringPartition(recurringReference),
      );
      cleanup.check();
      evidence.mark('fixture-ready', {
        schema: f.schema,
        reference,
        recurringReference,
      });
    }, 120_000);
    afterEach(async ({ task }) => {
      const local = locals.get(task);
      if (!local) return;
      const finished = local.cleanup.finish(task.result);
      // A case blocked before acquisition must not replace an unfinished owner.
      if (local.state.fixtureStarted)
        predecessor = { test: task.name, finished };
      try {
        await finished;
      } finally {
        await local.saveClose();
      }
    }, 30_000);
    afterAll(() => vi.unstubAllEnvs(), 30_000);

    it.for([
      'poll-only',
      'delivery',
      'busy-tick',
      'throwing-callback',
      'cold-resume',
      'recurring',
    ] as const)(
      '%s starts each real reminder once and counts committed deliveries',
      async (mode, { task }) => {
        const { state, evidence, cleanup, own } = locals.get(task)!;
        cleanup.check();
        const f = state.f!;
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
            const tick = ++tickCount;
            evidence.mark('tick-start', { tick, status: service.status() });
            try {
              const result = await service.tick();
              evidence.mark('tick-result', {
                tick,
                result,
                status: service.status(),
              });
              if (stopping) return;
              if (holdAfterConsumer) {
                holdAfterConsumer = false;
                evidence.mark('busy-barrier');
                passedConsumer.resolve();
                await release.promise;
                evidence.mark('busy-release');
              }
            } catch (error) {
              errors.push(error);
              evidence.mark('tick-error', {
                tick,
                error,
                status: service.status(),
              });
            } finally {
              evidence.mark('tick-end', { tick, status: service.status() });
            }
          },
          () => !stopping,
        );
        const makeService = () =>
          createNativeOnceWorkerService(
            {
              workerId,
              source: (mode === 'recurring'
                ? state.recurringSource
                : state.source)!,
              readMaintenance: async () => null,
              ...(mode === 'poll-only'
                ? {}
                : {
                    onDelivery: () => {
                      callbacks++;
                      evidence.mark('on-delivery', {
                        callbacks,
                        status: service.status(),
                      });
                      delivered.resolve();
                      if (mode === 'throwing-callback')
                        throw new Error('injected wake failure');
                      automation.request();
                    },
                  }),
            },
            {
              createRuntime: (options) =>
                createNativeOnceWorkerRuntime(
                  options,
                  options.reference.profileId === 'allrice-once-control-v1'
                    ? {
                        loadDatabase: async () => {
                          const module: unknown =
                            await import('@allrice/database');
                          const db = module as NativeOnceWorkerDatabasePorts;
                          return {
                            ...db,
                            createNativeOnceSqlStore(input) {
                              const store = db.createNativeOnceSqlStore(input);
                              return {
                                ...store,
                                ...observeControlWrites(store, evidence),
                              };
                            },
                          };
                        },
                      }
                    : undefined,
                ),
            },
          );
        let service = makeService();
        const queue = createCoalescedTick(
          async () => {
            try {
              for (;;) {
                const job = await claimNextJob(workerId, 300_000);
                if (!job) return;
                if (stopping) return;
                const claim = { jobId: job.id, runId: null as string | null };
                evidence.mark('queue-claim', claim);
                const execution = await startClaimedJob(
                  workerId,
                  job.id,
                  job.lease!.token,
                );
                claim.runId = execution?.context.runId ?? null;
                evidence.mark('queue-start', { ...claim });
                if (stopping) return;
              }
            } catch (error) {
              errors.push(error);
              evidence.mark('queue-error', error);
            }
          },
          () => !stopping,
        );
        let poll: ReturnType<typeof setInterval> | undefined;
        const wakeups = startQueueWakeups({
          listen: listenForReadyJobs,
          probe: probeReadyJobs,
          wake: (reason) => {
            evidence.mark('queue-wake', { reason });
            queue.request();
          },
          log: { info: () => {}, warn: () => {} },
        });
        const ids: string[] = [];
        state.observe = () => ({
          mode,
          workerId,
          ids,
          stopping,
          tickCount,
          callbacks,
          errors,
          service: service.status(),
          wakeups: wakeups.status(),
        });
        own('runtime', async () => {
          stopping = true;
          release.resolve();
          if (poll) clearInterval(poll);
          const results = await Promise.allSettled([
            wakeups.stop(),
            service.stop(),
            automation.current(),
            queue.current(),
          ]);
          evidence.mark('runtime-drained', {
            results,
            runtime: state.observe?.(),
          });
          expect(service.status().state).toBe('closed');
          for (const result of results)
            if (result.status === 'rejected') throw result.reason;
          return { results, runtime: state.observe?.() };
        });
        try {
          await vi.waitFor(() =>
            expect(wakeups.status().state).toBe('listening'),
          );
          cleanup.check();
          const sampleCount =
            mode === 'poll-only' || mode === 'delivery' ? 3 : 1;
          const [clock] = await f.db<
            { now: Date }[]
          >`select clock_timestamp() as now`;
          cleanup.check();
          evidence.mark('sql-clock', {
            sql: clock!.now,
            wall: new Date().toISOString(),
          });
          for (let i = 0; i < sampleCount; i++) {
            const session = await createChatSession(f.context, {
              workspaceId: f.workspaceId,
              employeeAssignmentId: f.assignmentId,
              title: `MET-223 ${mode} ${i}`,
            });
            cleanup.check();
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
            cleanup.check();
            ids.push(task.id);
            evidence.mark('task-created', {
              automationId: task.id,
              sessionId: session.id,
              due: new Date(
                clock!.now.getTime() +
                  10_000 +
                  (mode === 'recurring' ? 0 : 333 * i),
              ).toISOString(),
            });
          }
          evidence.mark('host-boot-start', { status: service.status() });
          await automation.tick(); // Boots the actual Host and arms the timers.
          cleanup.check();
          evidence.mark('host-boot-end', { status: service.status() });
          expect(service.status()).toMatchObject({
            state: 'active',
            deliveryWakeRequests: 0,
          });
          const native =
            mode === 'recurring'
              ? await f.db`select native_task_id from allrice_native_recurring_controls where automation_id in ${f.db(ids)}`
              : await f.db`select native_task_id from allrice_native_once_controls where automation_id in ${f.db(ids)}`;
          cleanup.check();
          evidence.mark('native-tasks', { ids, native });
          expect(native).toHaveLength(sampleCount);
          expect(
            native.every((row) => typeof row.native_task_id === 'string'),
          ).toBe(true);
          if (mode === 'cold-resume') {
            evidence.mark('cold-stop-start', { status: service.status() });
            await service.stop();
            cleanup.check();
            evidence.mark('cold-stop-end', { status: service.status() });
            expect(service.status().state).toBe('closed');
            service = makeService();
            evidence.mark('cold-resume-start');
            await automation.tick();
            cleanup.check();
            evidence.mark('cold-resume-end', { status: service.status() });
            expect(
              await f.db`select native_task_id from allrice_native_once_controls where automation_id in ${f.db(ids)}`,
            ).toEqual(native);
            cleanup.check();
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
            // Reject inside the test body so task cleanup still drains the Host
            // if a regression prevents the consumer or delivery from firing.
            await within(passedConsumer.promise, 'the initial consumer');
            cleanup.check();
            await within(delivered.promise, 'the real timer delivery');
            cleanup.check();
            // The consumer already ran. Only the coalesced follow-up can see the receipt.
            expect(
              await f.db`select run_id from allrice_automation_runs where automation_id in ${f.db(ids)}`,
            ).toHaveLength(0);
            cleanup.check();
            expect(tickCount).toBe(2);
            release.resolve();
            evidence.mark('busy-release-request');
          }
          // Let the actual timer reach its due time before querying for a Run.
          // Avoid ten seconds of unnecessary SQL polling on a shared test host.
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.max(0, clock!.now.getTime() + 10_000 - Date.now()),
            ),
          );
          cleanup.check();
          const rows = await vi.waitFor(
            async () => {
              cleanup.check();
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
              cleanup.check();
              expect(result).toHaveLength(sampleCount);
              expect(result.every((r) => r.delay_ms !== null)).toBe(true);
              return result;
            },
            { timeout: 25_000, interval: 50 },
          );
          cleanup.check();
          evidence.mark('runs-started', rows);
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
          cleanup.check();
          await automation.tick();
          cleanup.check();
          expect(
            await f.db`select run_id from allrice_automation_runs where automation_id in ${f.db(ids)}`,
          ).toHaveLength(sampleCount);
        } finally {
          evidence.mark('test-body-end', state.observe());
        }
      },
    );
  },
);

it('observing native control writes preserves promises, parameters, results and original cause errors', async () => {
  const args: Parameters<ObservedStore['commitMutation']> = [
    { partitionId: 'once', ownerId: 'worker', epoch: 1, token: 'test-token' },
    {
      writeId: 'write',
      digest: 'digest',
      mutation: { kind: 'session_ready', controlId: 'control' },
    },
  ];
  const committed = Promise.resolve<'committed' | 'rejected'>('committed');
  const exact = Promise.resolve<'committed' | 'absent' | 'unknown'>('unknown');
  const store = {
    commitMutation: vi
      .fn<ObservedStore['commitMutation']>()
      .mockReturnValue(committed),
    readExactCommit: vi
      .fn<ObservedStore['readExactCommit']>()
      .mockReturnValue(exact),
  };
  const events: { phase: string; details: unknown }[] = [];
  const observed = observeControlWrites(store, {
    mark: (phase, details) => {
      events.push({ phase, details });
    },
  });
  expect(observed.commitMutation(...args)).toBe(committed);
  expect(await committed).toBe('committed');
  expect(store.commitMutation.mock.calls[0]![0]).toBe(args[0]);
  expect(store.commitMutation.mock.calls[0]![1]).toBe(args[1]);
  expect(observed.readExactCommit(...args)).toBe(exact);
  expect(await exact).toBe('unknown');
  expect(events.at(-1)).toMatchObject({
    phase: 'native-write-result',
    details: { operation: 'readExactCommit', result: 'unknown' },
  });
  expect(store.readExactCommit.mock.calls[0]![0]).toBe(args[0]);
  expect(store.readExactCommit.mock.calls[0]![1]).toBe(args[1]);
  const cause = Object.assign(new Error('lock unavailable'), { code: '55P03' });
  const original = new Error('commit failed', { cause });
  const rejected = Promise.reject(original);
  store.commitMutation.mockReturnValueOnce(rejected);
  const failure = observed.commitMutation(...args);
  expect(failure).toBe(rejected);
  await expect(failure).rejects.toBe(original);
  expect(events.at(-1)).toMatchObject({
    phase: 'native-write-error',
    details: {
      operation: 'commitMutation',
      writeId: 'write',
      controlId: 'control',
      mutation: args[1].mutation,
      error: {
        name: 'Error',
        message: 'commit failed',
        cause: { name: 'Error', message: 'lock unavailable', code: '55P03' },
      },
    },
  });
  const brokenDiagnostics = observeControlWrites(store, {
    mark: () => {
      throw new Error('diagnostic failure');
    },
  });
  expect(brokenDiagnostics.readExactCommit(...args)).toBe(exact);
  expect(await exact).toBe('unknown');
});
