import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { ScheduleTask } from '@deepseek-ai/dsh-schedule';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { NATIVE_JOURNAL_CONTRACT } from '../../../../packages/contracts/src/native-journal-contract.ts';
import {
  nativeOnceDigest,
  nativeOnceWriterRemaining,
  prepareNativeOnceMutation,
  type NativeOnceOccurrence,
  type NativeOnceSnapshot,
  type NativeOnceWriterRow,
} from '../../../../packages/database/src/native-schedule-once-state.ts';
import {
  NativeRecurringRevisionSchema,
  prepareNativeRecurringMutation,
  type NativeRecurringOccurrence,
  type NativeRecurringRevision,
  type NativeRecurringSnapshot,
} from '../../../../packages/database/src/native-schedule-recurring-state.ts';
import { runtimePolicyDigest } from '../../../../packages/database/src/runtime-policy.ts';
import { applyNativeOnceWorkspaceWrite } from '../../../../packages/database/src/native-schedule-workspace-state.ts';
import { measureDshNativeArtifact } from '../../src/harness/dsh-native-artifact.js';
import {
  createNativeScheduleOnceController,
  type NativeScheduleAnyControl,
  type NativeScheduleControl,
  type NativeScheduleControlReference,
  type NativeScheduleOnceStore,
  type NativeScheduleRecurringControl,
  type NativeScheduleWrite,
  type NativeScheduleWriter,
} from '../../src/native-schedule-once.js';
import {
  createNativeOnceControlSource,
  verifyNativeOnceControlHistory,
  type NativeOnceLoaderTestPorts,
} from '../../src/native-schedule-once-loader.js';
import {
  controlCorpusDir,
  installControlCorpus,
  type ControlScenario,
  type ControlScenarioId,
  type ControlStoreImage,
} from './control-corpus.js';
import { corpusRoot, projectKey } from './journal-corpus.js';

const { current, readsFrom } = NATIVE_JOURNAL_CONTRACT;
const corpora = await Promise.all(
  (await readdir(corpusRoot))
    .filter((name) => /^contract-\d+$/.test(name))
    .map(async (name) => {
      const dir = controlCorpusDir(join(corpusRoot, name));
      const manifest = await readFile(join(dir, 'manifest.json'), 'utf8')
        .then(
          (text) =>
            JSON.parse(text) as {
              capturedWith: { contract: { current: number } };
              scenarios: ControlScenario[];
            },
        )
        .catch(() => null);
      const scenario = (id: ControlScenarioId) =>
        manifest!.scenarios.find((item) => item.id === id)!;
      return {
        dir,
        name,
        version: manifest?.capturedWith.contract.current,
        scenario,
      };
    }),
);
type Corpus = (typeof corpora)[number];

// The controller and Host run from this tree's measured primary, as the
// Worker loads them; the frozen reference records an earlier birth artifact.
let controlPorts: NativeOnceLoaderTestPorts;
beforeAll(async () => {
  const root = resolve(import.meta.dirname, '../../../..');
  const measured = await measureDshNativeArtifact(root, undefined, {
    schemaVersion: 2,
  });
  controlPorts = {
    currentArtifact: () => ({
      artifactId: measured.artifactId,
      generation: measured.content.generation,
      root,
      content: measured.content,
    }),
  };
}, 120_000);

/** The production SQL store of one partition without SQL: its pure state
 * machine (`prepareNative*Mutation`, `applyNativeOnceWorkspaceWrite`) decides
 * every write behind an epoch writer fence, and a refusal is `rejected` as the
 * SQL store reports it. No tenant admission is locked, so a receipt's outbox is
 * planned as blocked; nothing here dispatches a Run. */
function memoryStore(
  image: ControlStoreImage,
  reference: NativeScheduleControlReference,
  decodeTask: (value: unknown) => ScheduleTask,
) {
  type Snapshot = NativeOnceSnapshot | NativeRecurringSnapshot;
  const snapshots = new Map<string, Snapshot>(
    image.controls.map((control) => [
      control.controlId,
      {
        control: structuredClone(control),
        task:
          control.nativeTaskId === null
            ? null
            : structuredClone(image.tasks[control.nativeTaskId] ?? null),
      } as Snapshot,
    ]),
  );
  const { partitionId } = image.controls[0] as unknown as {
    partitionId: string;
  };
  let workspace = structuredClone(image.workspace);
  const writes: NativeScheduleWrite[] = [];
  const occurrences: (NativeOnceOccurrence | NativeRecurringOccurrence)[] = [];
  const rejections: unknown[] = [];
  const released: number[] = [];
  // The partition's writer row, kept apart from what callers present: an
  // acquire replaces it, a renew extends it, a release closes it.
  const TTL = 60_000;
  let row: NativeOnceWriterRow = {
    partitionId,
    ownerId: null,
    epoch: 0,
    tokenDigest: null,
    expiresAtMs: null,
    closed: true,
    reference,
  };
  const live = (writer: NativeScheduleWriter) =>
    nativeOnceWriterRemaining(row, writer, Date.now()) > 0;
  const controls = () =>
    [...snapshots.values()].map(({ control }) => structuredClone(control));
  const readiness = {
    enabled: true,
    storageReady: true,
    legacyClockExcluded: true,
    controlArtifactApproved: true,
  };
  const revisions = (automationId: string) =>
    new Map(
      (image.revisions?.[automationId] ?? []).map((value) => {
        const revision = NativeRecurringRevisionSchema.parse(value);
        return [revision.revision, revision];
      }),
    );
  const store: NativeScheduleOnceStore = {
    async acquireWriter() {
      const writer = {
        partitionId,
        ownerId: 'journal-corpus-replay',
        epoch: row.epoch + 1,
        token: randomUUID(),
      };
      row = {
        partitionId,
        ownerId: writer.ownerId,
        epoch: writer.epoch,
        tokenDigest: nativeOnceDigest(writer.token),
        expiresAtMs: Date.now() + TTL,
        closed: false,
        reference,
      };
      return {
        writer,
        remainingMs: TTL,
        reference,
        controls: controls() as never,
      };
    },
    async renewWriter(writer) {
      if (!live(writer)) return null;
      row.expiresAtMs = Date.now() + TTL;
      return { writer: { ...writer }, remainingMs: TTL };
    },
    async assertWriter(writer) {
      return live(writer);
    },
    async loadControls() {
      return controls() as never;
    },
    async loadTaskRecords() {
      return Object.fromEntries(
        [...snapshots.values()].flatMap(({ task }) =>
          task === null
            ? []
            : [[(task as ScheduleTask).record.id, structuredClone(task)]],
        ),
      );
    },
    async commitMutation(writer, write) {
      const before =
        write.mutation.kind === 'calendar'
          ? undefined
          : snapshots.get(write.mutation.controlId);
      if (!live(writer) || !before) return 'rejected';
      try {
        const input = {
          readiness,
          writerRow: structuredClone(row),
          writer,
          dbNowMs: Date.now(),
          write: write as never,
          decodeTask: decodeTask as never,
        };
        if ('kind' in before.control && before.control.kind === 'recurring') {
          const planned = prepareNativeRecurringMutation({
            ...input,
            reference,
            before: before as NativeRecurringSnapshot,
            revisions: revisions(before.control.automationId),
          });
          snapshots.set(before.control.controlId, planned.after);
          occurrences.push(...planned.occurrences);
        } else {
          const planned = prepareNativeOnceMutation({
            ...input,
            before: before as NativeOnceSnapshot,
          });
          snapshots.set(before.control.controlId, planned.after);
          if (planned.occurrence) occurrences.push(planned.occurrence);
        }
      } catch (error) {
        rejections.push(error);
        return 'rejected';
      }
      writes.push(structuredClone(write));
      return 'committed';
    },
    async readExactCommit(_writer, write) {
      return writes.some((item) => isDeepStrictEqual(item, write))
        ? 'committed'
        : 'absent';
    },
    async loadWorkspaceUnit() {
      return structuredClone(workspace);
    },
    async commitWorkspaceWrite(writer, write) {
      if (!live(writer)) throw new Error('workspace writer fence rejected');
      workspace = applyNativeOnceWorkspaceWrite(workspace, write, {
        stateRoot: reference.stateRoot,
        controlSessionIds: new Set(controls().map((c) => c.controlSessionId)),
      });
      return { revision: workspace.revision };
    },
    async releaseClosedWriter(writer) {
      if (!live(writer)) throw new Error('release by a stale writer');
      row.closed = true;
      released.push(writer.epoch);
    },
  };
  const puts = () =>
    writes.flatMap(({ mutation }) =>
      mutation.kind === 'put_task' ? [mutation] : [],
    );
  const snapshot = (controlId: string) =>
    snapshots.get(controlId)! as {
      control: NativeScheduleAnyControl;
      task: ScheduleTask | null;
    };
  return {
    store,
    writes,
    occurrences,
    rejections,
    released,
    puts,
    snapshot,
  };
}

/** Install one frozen partition under a fresh stateRoot, as the next release
 * finds it after a deploy: journals on disk, rows behind the store. `edit`
 * changes the rows first, as a product API would while the Worker is down. */
async function replay(
  corpus: Corpus,
  id: ControlScenarioId,
  edit?: (image: ControlStoreImage) => void,
) {
  const scenario = corpus.scenario(id);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-control-replay-')),
  );
  const stateRoot = join(root, 'state');
  await mkdir(stateRoot);
  try {
    const image = await installControlCorpus(corpus.dir, scenario, stateRoot);
    const frozenImage = structuredClone(image);
    edit?.(image);
    const reference = { ...scenario.reference, stateRoot };
    const journal = (sessionId: string) =>
      readFile(
        join(
          stateRoot,
          'sessions',
          projectKey(stateRoot),
          sessionId,
          'session.v4.jsonl',
        ),
        'utf8',
      );
    const frozen = new Map(
      await Promise.all(
        image.controls.map(
          async (c) =>
            [c.controlSessionId, await journal(c.controlSessionId)] as const,
        ),
      ),
    );
    // The old release stopped after its last journal event.
    const stoppedAt = Math.max(
      ...[...frozen.values()].flatMap((text) =>
        text
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const event = JSON.parse(line) as {
              time?: number;
              createdAt?: number;
            };
            return event.time ?? event.createdAt ?? 0;
          }),
      ),
    );
    const { schedule } = await createNativeOnceControlSource(
      reference,
      controlPorts,
    ).loadModules();
    const memory = memoryStore(image, reference, (value) =>
      schedule.scheduleDomain.tables.tasks.valueSchema.parse(value),
    );
    const controllers: Controller[] = [];
    return {
      image,
      frozenImage,
      memory,
      history: () =>
        verifyNativeOnceControlHistory(reference, image.controls, controlPorts),
      /** The next release comes up at `at` (epoch ms), derived from the
       * frozen targets so every replay sees the same due work. Only Date is
       * replaced; it moves with real time and every timer stays real. */
      startAt(at: number) {
        expect(at).toBeGreaterThan(stoppedAt);
        vi.useFakeTimers({
          now: at,
          toFake: ['Date'],
          shouldAdvanceTime: true,
        });
      },
      /** A later restart, after the first replay process stopped. */
      restartAt(at: number) {
        vi.setSystemTime(at);
      },
      // A new process: a new controller and Host over the same root and rows.
      open() {
        const controller = createNativeScheduleOnceController({
          enabled: true,
          store: memory.store,
          source: createNativeOnceControlSource(reference, controlPorts),
        });
        controllers.push(controller);
        return controller;
      },
      async stop(controller: Controller) {
        await controller.stop();
        expect(controller.status()).toMatchObject({
          state: 'closed',
          fault: undefined,
        });
      },
      /** The schedule reminders this build appended to each control
       * Session: the user messages DSH splices into its inbox when a task
       * fires, by message ID (a receipt's messageId) and occurrence. This build
       * appends to the frozen journals and never rewrites them. */
      async reminders() {
        const found: Record<string, { id: string; at: string[] }[]> = {};
        for (const c of image.controls) {
          const before = frozen.get(c.controlSessionId)!;
          const after = await journal(c.controlSessionId);
          expect(after.startsWith(before)).toBe(true);
          found[c.controlId] = after
            .slice(before.length)
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((event) => event.type === 'agent/inbox/spliced')
            .flatMap((event) => event.data.inserted ?? [])
            .filter((message) => message.source?.kind === 'schedule')
            .map((message) => ({
              id: message.id,
              at: [
                ...JSON.stringify(message.content).matchAll(
                  /occurrence_at\\?"?:\s*\\?"?([0-9T:.-]+Z)/g,
                ),
              ].map((match) => match[1]!),
            }));
        }
        return found;
      },
      async close() {
        try {
          for (const controller of controllers) await controller.stop();
          for (const controller of controllers)
            expect(controller.status().stats.adapterCalls).toBe(0);
          expect(memory.rejections).toEqual([]);
        } finally {
          vi.useRealTimers();
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
type Run = Awaited<ReturnType<typeof replay>>;

type Controller = ReturnType<typeof createNativeScheduleOnceController>;
type Memory = ReturnType<typeof memoryStore>;
/** Real Schedule timers fire on their own; ticks renew the lease. */
async function tickUntil(
  controller: Controller,
  memory: Memory,
  done: () => boolean,
) {
  const deadline = performance.now() + 20_000;
  for (;;) {
    await controller.tick();
    expect(
      controller.status(),
      JSON.stringify({
        status: controller.status(),
        rejections: memory.rejections.map(String),
      }),
    ).toMatchObject({ state: 'active', fault: undefined });
    if (done()) return;
    if (performance.now() > deadline)
      throw new Error('Timed out waiting for the control Host');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
/** A later process reads back what this build appended and changes
 * nothing: no write, no reminder. */
async function reopen(run: Run) {
  const writes = run.memory.writes.length;
  const reminders = await run.reminders();
  const controller = run.open();
  let ticks = 0;
  await tickUntil(controller, run.memory, () => ++ticks > 5);
  await run.stop(controller);
  expect(run.memory.writes).toHaveLength(writes);
  expect(run.memory.released).toEqual([1, 2]);
  expect(await run.reminders()).toEqual(reminders);
}
/** Exactly one reminder per receipt, in the Session of its control. */
const remindedOnly = (
  run: Run,
  receipts: Record<string, { messageId: string; scheduledAt: string }>,
) =>
  Object.fromEntries(
    run.image.controls.map((c) => {
      const receipt = receipts[c.controlId];
      return [
        c.controlId,
        receipt ? [{ id: receipt.messageId, at: [receipt.scheduledAt] }] : [],
      ];
    }),
  );
const kinds = (run: Run) =>
  run.memory.writes.map(({ mutation }) => [
    mutation.kind,
    'controlId' in mutation ? mutation.controlId : null,
  ]);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type OnceControl = NativeScheduleControl & {
  dispatch: { occurrenceId: string };
};
/** The once partition: a refused creation, a delivered task, a due one. */
function onceControls(image: ControlStoreImage) {
  const controls = image.controls as OnceControl[];
  const task = (c: OnceControl) =>
    c.nativeTaskId === null
      ? null
      : (image.tasks[c.nativeTaskId] as ScheduleTask);
  const only = (test: (c: OnceControl) => boolean) => {
    const found = controls.filter(test);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  return {
    task,
    refused: only((c) => task(c) === null),
    delivered: only((c) => !!task(c)?.lastDelivery),
    due: only((c) => !!task(c) && !task(c)!.lastDelivery),
  };
}
/** The recurring partition: every 60 seconds and daily, each delivered once. */
function recurringControls(image: ControlStoreImage) {
  const controls = image.controls as NativeScheduleRecurringControl[];
  const task = (c: NativeScheduleRecurringControl) =>
    image.tasks[c.nativeTaskId!] as ScheduleTask;
  const only = (kind: string) => {
    const found = controls.filter((c) => c.appliedRule?.kind === kind);
    expect(found).toHaveLength(1);
    return found[0]!;
  };
  expect(controls).toHaveLength(2);
  return { task, every: only('every'), daily: only('daily') };
}
/** `reservation()` of native-schedule-recurring-product.ts, as
 * changeRecurringTask signs a new revision: the automation's scope and
 * dispatch plus the revision. */
function reservation(
  c: NativeScheduleRecurringControl,
  revision: Omit<NativeRecurringRevision, 'reservationDigest'>,
) {
  const { dispatch } = c as unknown as {
    dispatch: {
      employeeAssignmentId: string;
      employeeInstanceId: string;
      businessSessionId: string;
    };
  };
  return runtimePolicyDigest({
    organizationId: c.organizationId,
    workspaceId: c.workspaceId,
    ownerId: c.ownerId,
    automationId: c.automationId,
    assignmentId: dispatch.employeeAssignmentId,
    instanceId: dispatch.employeeInstanceId,
    sessionId: dispatch.businessSessionId,
    ...revision,
  });
}
/** The one delivery a release starting at `at` owes: the latest missed
 * occurrence on the rule's grid (Asia/Shanghai has no DST), then the next. */
function expectDelivery(
  run: Run,
  control: NativeScheduleRecurringControl,
  frozen: ScheduleTask,
  at: number,
  period: number,
) {
  const target = Date.parse(frozen.record.scheduledAt);
  const occurrence = target + Math.floor((at - target) / period) * period;
  const puts = run.memory
    .puts()
    .filter(({ controlId }) => controlId === control.controlId);
  expect(puts).toHaveLength(1);
  const [put] = puts;
  expect(put!.task).toMatchObject({
    record: {
      id: control.nativeTaskId,
      scheduledAt: new Date(occurrence + period).toISOString(),
    },
    status: 'active',
    lastDelivery: { scheduledAt: new Date(occurrence).toISOString() },
  });
  const receipt = put!.task.deliveryHistory!.records.at(-1)!;
  const history = frozen.deliveryHistory!.records;
  // Earlier receipts stay unless DSH's 30-day retention prunes them.
  expect(put!.task.deliveryHistory).toEqual(
    at - Date.parse(history.at(-1)!.deliveredAt) < 30 * DAY
      ? {
          records: [...history, receipt],
          earlierRecordsUnavailable: false,
          earlierRecordsPruned: false,
        }
      : {
          records: [receipt],
          earlierRecordsUnavailable: true,
          earlierRecordsPruned: true,
        },
  );
  // The receipt plans the occurrence the business dispatch consumes.
  expect(
    run.memory.occurrences.filter(
      (o) => o.payload.nativeTaskId === control.nativeTaskId,
    ),
  ).toMatchObject([
    {
      payload: {
        revision: { revision: control.revision, rule: control.rule },
        receipt,
      },
    },
  ]);
  return receipt;
}

// One frozen control corpus per readable journal contract version (MET-221),
// captured by dsh-control-journal-capture.test.ts beside the chat corpus.
describe('DSH schedule control corpus', () => {
  it('keeps one control corpus for every readable contract version', () => {
    for (const { name, version } of corpora)
      expect(version, `${name} has no control corpus`).toBe(
        Number(name.slice('contract-'.length)),
      );
    expect(
      corpora.map(({ version }) => version!).sort((a, b) => a - b),
    ).toEqual(
      Array.from({ length: current - readsFrom + 1 }, (_, i) => readsFrom + i),
    );
  });

  describe.each(corpora.map((corpus) => [corpus.name, corpus] as const))(
    '%s under the installed runtime',
    (_name, corpus) => {
      it.each(['journal', 'store'] as const)(
        'refuses a one-byte edit of a control %s before installing it',
        async (kind) => {
          const root = await mkdtemp(
            join(tmpdir(), 'allrice-control-integrity-'),
          );
          try {
            const scenario = corpus.scenario('once');
            const files = [...scenario.files, scenario.store];
            const changed =
              kind === 'store' ? scenario.store : scenario.files[0]!;
            for (const file of files) {
              const bytes = await readFile(join(corpus.dir, file.path));
              if (file === changed) bytes[0] = bytes[0]! ^ 1;
              const copy = join(root, 'corpus', file.path);
              await mkdir(dirname(copy), { recursive: true });
              await writeFile(copy, bytes);
            }
            await mkdir(join(root, 'state'));
            await expect(
              installControlCorpus(
                join(root, 'corpus'),
                scenario,
                join(root, 'state'),
              ),
            ).rejects.toThrow(`Corpus file changed: ${changed.path}`);
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        },
      );

      it('restores the once controller on its frozen journals and delivers the due task once', async () => {
        const run = await replay(corpus, 'once');
        try {
          const { task, refused, delivered, due } = onceControls(run.image);
          expect(refused.command.status).toBe('blocked');
          expect(
            run.image.controls.every((c) => c.sessionState === 'ready'),
          ).toBe(true);
          expect(await run.history()).toBe(3);

          // The release comes up 90 seconds after the pending task was due.
          const at = Date.parse(due.at) + 90_000;
          run.startAt(at);
          const first = run.open();
          await tickUntil(
            first,
            run.memory,
            () => run.memory.puts().length > 0,
          );
          await run.stop(first);
          expect(kinds(run)).toEqual([['put_task', due.controlId]]);
          const [put] = run.memory.puts();
          expect(put!.task).toMatchObject({
            record: { id: due.nativeTaskId, scheduledAt: due.at },
            status: 'inactive',
            lastDelivery: { scheduledAt: due.at },
          });
          expect(
            Date.parse(put!.task.lastDelivery!.deliveredAt),
          ).toBeGreaterThanOrEqual(at);
          // The receipt plans the occurrence the business dispatch consumes.
          expect(run.memory.occurrences).toMatchObject([
            {
              id: due.dispatch.occurrenceId,
              payload: {
                nativeTaskId: due.nativeTaskId,
                receipt: put!.task.lastDelivery,
              },
            },
          ]);
          for (const c of [refused, delivered])
            expect(run.memory.snapshot(c.controlId)).toEqual({
              control: c,
              task: task(c),
            });
          expect(run.memory.released).toEqual([1]);
          expect(await run.reminders()).toEqual(
            remindedOnly(run, { [due.controlId]: put!.task.lastDelivery! }),
          );

          await reopen(run);
          expect(await run.history()).toBe(3);
        } finally {
          await run.close();
        }
      }, 60_000);

      it('cancels a pending once task on its frozen journal so it never fires', async () => {
        // As the product's cancel leaves the row while the Worker is down.
        const run = await replay(corpus, 'once', (image) => {
          onceControls(image).due.command = {
            id: randomUUID(),
            kind: 'delete',
            status: 'pending',
          };
        });
        try {
          const { due } = onceControls(run.image);
          run.startAt(Date.parse(due.at) - 30_000);
          const first = run.open();
          await tickUntil(
            first,
            run.memory,
            () => run.memory.writes.length > 1,
          );
          await run.stop(first);
          expect(kinds(run)).toEqual([
            ['delete_task', due.controlId],
            ['confirm_command', due.controlId],
          ]);
          expect(run.memory.snapshot(due.controlId)).toMatchObject({
            control: {
              taskDeleted: true,
              command: { kind: 'delete', status: 'confirmed' },
            },
            task: null,
          });

          expect(await run.reminders()).toEqual(remindedOnly(run, {}));

          // Restarting after its time delivers nothing.
          run.restartAt(Date.parse(due.at) + 90_000);
          await reopen(run);
          expect(run.memory.occurrences).toEqual([]);
        } finally {
          await run.close();
        }
      }, 60_000);

      it.each([
        ['keeps the earlier receipts', 90_000],
        ["prunes them past DSH's 30-day retention", 31 * DAY + 90_000],
      ])(
        'restores the recurring controller on its frozen journal and delivers each missed occurrence once: %s',
        async (_label, delay) => {
          const run = await replay(corpus, 'recurring');
          try {
            const { task, every, daily } = recurringControls(run.image);
            for (const c of [every, daily]) {
              expect(c).toMatchObject({ sessionState: 'ready' });
              expect(task(c).deliveryHistory!.records).toHaveLength(1);
            }
            expect(daily.appliedRule).toMatchObject({
              timezone: 'Asia/Shanghai',
            });
            expect(await run.history()).toBe(2);

            // The release comes up `delay` after the minute rule's next target;
            // the daily one is due only once a day has passed.
            const at = Date.parse(task(every).record.scheduledAt) + delay;
            const owed = [every, daily].filter(
              (c) => Date.parse(task(c).record.scheduledAt) <= at,
            );
            run.startAt(at);
            const first = run.open();
            await tickUntil(
              first,
              run.memory,
              () => run.memory.puts().length >= owed.length,
            );
            await run.stop(first);
            expect(run.memory.puts()).toHaveLength(owed.length);
            const receipts = {
              [every.controlId]: expectDelivery(
                run,
                every,
                task(every),
                at,
                MINUTE,
              ),
              ...(owed.includes(daily)
                ? {
                    [daily.controlId]: expectDelivery(
                      run,
                      daily,
                      task(daily),
                      at,
                      DAY,
                    ),
                  }
                : {}),
            };
            expect(await run.reminders()).toEqual(remindedOnly(run, receipts));

            await reopen(run);
            expect(await run.history()).toBe(2);
          } finally {
            await run.close();
          }
        },
        60_000,
      );

      it('applies a pending recurring rule change on its frozen journal', async () => {
        const rule = { kind: 'every' as const, seconds: 120 };
        // As the product's update leaves the rows while the Worker is down.
        const run = await replay(corpus, 'recurring', (image) => {
          const { task, every } = recurringControls(image);
          const versions = image.revisions![every.automationId]!;
          const { reservationDigest, ...first } =
            NativeRecurringRevisionSchema.parse(versions[0]);
          // The product's reservation digest, checked on the frozen row.
          expect(reservation(every, first)).toBe(reservationDigest);
          const next = {
            ...first,
            revision: 2,
            rule,
            acceptedAt: new Date(
              Date.parse(task(every).record.scheduledAt) - 40_000,
            ).toISOString(),
          };
          versions.push({
            ...next,
            reservationDigest: reservation(every, next),
          });
          every.revision = 2;
          every.rule = rule;
          every.command = {
            id: randomUUID(),
            kind: 'update',
            status: 'pending',
          };
        });
        try {
          const { task, every, daily } = recurringControls(run.frozenImage);
          const at = Date.parse(task(every).record.scheduledAt) - 30_000;
          run.startAt(at);
          const first = run.open();
          await tickUntil(
            first,
            run.memory,
            () => run.memory.writes.length > 1,
          );
          await run.stop(first);
          expect(kinds(run)).toEqual([
            ['put_task', every.controlId],
            ['confirm_command', every.controlId],
          ]);
          const { control, task: changed } = run.memory.snapshot(
            every.controlId,
          );
          expect(control).toMatchObject({
            revision: 2,
            appliedRevision: 2,
            appliedRule: rule,
            command: { kind: 'update', status: 'confirmed' },
          });
          expect(changed).toMatchObject({
            record: {
              id: every.nativeTaskId,
              kind: 'every',
              everySeconds: 120,
            },
            status: 'active',
            deliveryHistory: task(every).deliveryHistory,
          });
          expect(Date.parse(changed!.record.scheduledAt)).toBeGreaterThan(at);
          expect(run.memory.snapshot(daily.controlId)).toEqual({
            control: daily,
            task: task(daily),
          });
          expect(await run.reminders()).toEqual(remindedOnly(run, {}));

          await reopen(run);
        } finally {
          await run.close();
        }
      }, 60_000);

      it('deletes a recurring task on its frozen journal so it never fires again', async () => {
        const run = await replay(corpus, 'recurring', (image) => {
          recurringControls(image).every.command = {
            id: randomUUID(),
            kind: 'delete',
            status: 'pending',
          };
        });
        try {
          const { task, every, daily } = recurringControls(run.frozenImage);
          const target = Date.parse(task(every).record.scheduledAt);
          run.startAt(target - 30_000);
          const first = run.open();
          await tickUntil(
            first,
            run.memory,
            () => run.memory.writes.length > 1,
          );
          await run.stop(first);
          expect(kinds(run)).toEqual([
            ['delete_task', every.controlId],
            ['confirm_command', every.controlId],
          ]);
          expect(run.memory.snapshot(every.controlId)).toMatchObject({
            control: {
              taskDeleted: true,
              command: { kind: 'delete', status: 'confirmed' },
            },
            task: null,
          });

          expect(await run.reminders()).toEqual(remindedOnly(run, {}));

          // Restarting after its next target delivers nothing.
          run.restartAt(target + 90_000);
          await reopen(run);
          expect(run.memory.occurrences).toEqual([]);
          expect(run.memory.snapshot(daily.controlId).task).toEqual(
            task(daily),
          );
        } finally {
          await run.close();
        }
      }, 60_000);
    },
  );
});
