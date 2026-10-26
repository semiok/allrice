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
import { beforeAll, describe, expect, it } from 'vitest';

import { NATIVE_JOURNAL_CONTRACT } from '../../../../packages/contracts/src/native-journal-contract.ts';
import { measureDshNativeArtifact } from '../../src/harness/dsh-native-artifact.js';
import {
  createNativeScheduleOnceController,
  type NativeScheduleControl,
  type NativeScheduleControlReference,
  type NativeScheduleOnceStore,
  type NativeScheduleRecurringControl,
  type NativeScheduleWrite,
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

/** The SQL store's contract for one partition, in memory: an epoch writer
 * fence, the exact-write readback, the workspace revision CAS, and mutations
 * applied to the control rows as the SQL store applies them. */
function memoryStore(
  image: ControlStoreImage,
  reference: NativeScheduleControlReference,
) {
  const controls = structuredClone(image.controls);
  const tasks = structuredClone(image.tasks);
  let workspace = structuredClone(image.workspace);
  const writes: NativeScheduleWrite[] = [];
  const released: number[] = [];
  let epoch = 0;
  const live = (writer: { epoch: number }) =>
    writer.epoch === epoch && !released.includes(epoch);
  const control = (id: string) => {
    const row = controls.find((c) => c.controlId === id);
    if (!row || row.kind === 'calendar') throw new Error('unknown control');
    return row;
  };
  const store: NativeScheduleOnceStore = {
    async acquireWriter() {
      epoch++;
      return {
        writer: {
          partitionId: 'journal-corpus',
          ownerId: 'journal-corpus-replay',
          epoch,
          token: `lease-${epoch}`,
        },
        remainingMs: 60_000,
        reference,
        controls: structuredClone(controls),
      };
    },
    async renewWriter(writer) {
      return live(writer)
        ? { writer: { ...writer }, remainingMs: 60_000 }
        : null;
    },
    async assertWriter(writer) {
      return live(writer);
    },
    async loadControls() {
      return structuredClone(controls);
    },
    async loadTaskRecords() {
      return structuredClone(tasks);
    },
    async commitMutation(writer, write) {
      if (!live(writer)) return 'rejected';
      const m = write.mutation;
      if (m.kind === 'calendar') throw new Error('no calendar controls');
      const c = control(m.controlId);
      if (m.kind === 'session_initializing') c.sessionState = 'initializing';
      if (m.kind === 'session_ready') c.sessionState = 'ready';
      if (m.kind === 'put_task') {
        if (c.nativeTaskId && c.nativeTaskId !== m.task.record.id)
          throw new Error('task rebinding');
        c.nativeTaskId = m.task.record.id;
        tasks[m.task.record.id] = structuredClone(m.task);
      }
      if (m.kind === 'delete_task') {
        delete tasks[m.nativeTaskId];
        c.taskDeleted = true;
      }
      if (m.kind === 'confirm_command') {
        c.command.status = 'confirmed';
        if (c.kind === 'recurring' && c.command.kind !== 'delete') {
          c.appliedRevision = c.revision;
          c.appliedRule = structuredClone(c.rule);
        }
      }
      if (m.kind === 'reject_command') c.command.status = 'blocked';
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
      if (!live(writer) || write.expectedRevision !== workspace.revision)
        throw new Error('workspace fence or revision rejected');
      const next = structuredClone(workspace);
      const m = write.mutation;
      if (m.kind === 'put_record') next.tables.workspaces[m.key] = m.value;
      else if (m.kind === 'delete_record') delete next.tables.workspaces[m.key];
      else next.global = m.value;
      next.revision++;
      workspace = next;
      return { revision: workspace.revision };
    },
    async releaseClosedWriter(writer) {
      released.push(writer.epoch);
    },
  };
  const puts = () =>
    writes.flatMap(({ mutation }) =>
      mutation.kind === 'put_task' ? [mutation] : [],
    );
  return { store, tasks, writes, released, puts };
}

/** Install one frozen partition under a fresh stateRoot, as the next release
 * finds it after a deploy: journals on disk, rows behind the store. */
async function replay(corpus: Corpus, id: ControlScenarioId) {
  const scenario = corpus.scenario(id);
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-control-replay-')),
  );
  const stateRoot = join(root, 'state');
  await mkdir(stateRoot);
  try {
    const image = await installControlCorpus(corpus.dir, scenario, stateRoot);
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
    const memory = memoryStore(image, reference);
    const controllers: ReturnType<typeof createNativeScheduleOnceController>[] =
      [];
    return {
      image,
      reference,
      memory,
      history: () =>
        verifyNativeOnceControlHistory(reference, image.controls, controlPorts),
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
      // This build appends to the frozen journals, never rewrites them.
      async appended(sessionId: string) {
        const before = frozen.get(sessionId)!;
        const after = await journal(sessionId);
        expect(after.startsWith(before)).toBe(true);
        return after.slice(before.length);
      },
      async close() {
        try {
          for (const controller of controllers) await controller.stop();
          for (const controller of controllers)
            expect(controller.status().stats.adapterCalls).toBe(0);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

type Controller = ReturnType<typeof createNativeScheduleOnceController>;
/** Real Schedule timers fire on their own; ticks renew the lease. */
async function tickUntil(controller: Controller, done: () => boolean) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    await controller.tick();
    expect(
      controller.status(),
      JSON.stringify(controller.status()),
    ).toMatchObject({ state: 'active', fault: undefined });
    if (done()) return;
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for the control Host');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const settle = (controller: Controller) => {
  let ticks = 0;
  return tickUntil(controller, () => ++ticks > 5);
};

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
          const controls = run.image.controls as NativeScheduleControl[];
          const task = (c: NativeScheduleControl) =>
            run.image.tasks[c.nativeTaskId!] as ScheduleTask;
          const delivered = controls.filter((c) => task(c).lastDelivery);
          const due = controls.filter((c) => !task(c).lastDelivery);
          expect([delivered.length, due.length]).toEqual([1, 1]);
          expect(controls.every((c) => c.sessionState === 'ready')).toBe(true);
          expect(Date.parse(due[0]!.at)).toBeLessThan(Date.now());
          expect(await run.history()).toBe(2);

          const first = run.open();
          await tickUntil(first, () => run.memory.puts().length > 0);
          const [put, ...more] = run.memory.puts();
          expect(more).toEqual([]);
          expect(put).toMatchObject({
            controlId: due[0]!.controlId,
            task: {
              record: { id: due[0]!.nativeTaskId, scheduledAt: due[0]!.at },
              status: 'inactive',
              lastDelivery: { scheduledAt: due[0]!.at },
            },
          });
          expect(run.memory.tasks[delivered[0]!.nativeTaskId!]).toEqual(
            task(delivered[0]!),
          );
          await first.stop();
          expect(run.memory.released).toEqual([1]);
          expect(await run.appended(due[0]!.controlSessionId)).not.toBe('');

          // A later process reads back what this build appended and
          // delivers nothing again.
          const writes = run.memory.writes.length;
          const second = run.open();
          await settle(second);
          await second.stop();
          expect(run.memory.writes).toHaveLength(writes);
          expect(run.memory.released).toEqual([1, 2]);
          for (const c of controls) await run.appended(c.controlSessionId);
          expect(await run.history()).toBe(2);
        } finally {
          await run.close();
        }
      }, 60_000);

      it('restores the recurring controller on its frozen journal and delivers the missed occurrence once', async () => {
        const run = await replay(corpus, 'recurring');
        try {
          const [control, ...others] = run.image
            .controls as NativeScheduleRecurringControl[];
          expect(others).toEqual([]);
          expect(control).toMatchObject({
            kind: 'recurring',
            sessionState: 'ready',
            appliedRule: { kind: 'every', seconds: 60 },
          });
          const frozen = run.image.tasks[
            control!.nativeTaskId!
          ] as ScheduleTask;
          const history = frozen.deliveryHistory!.records;
          expect(history).toHaveLength(1);
          const target = Date.parse(frozen.record.scheduledAt);
          expect(target).toBeLessThan(Date.now());
          expect(await run.history()).toBe(1);

          const before = Date.now();
          const first = run.open();
          await tickUntil(first, () => run.memory.puts().length > 0);
          const [put] = run.memory.puts();
          const records = put!.task.deliveryHistory!.records;
          const last = Date.parse(records.at(-1)!.scheduledAt);
          // DSH delivers only the latest missed occurrence on the rule's grid,
          // then schedules the next one strictly in the future.
          expect((last - target) % 60_000).toBe(0);
          expect(last).toBeGreaterThanOrEqual(target);
          expect(last).toBeLessThanOrEqual(Date.now());
          expect(put).toMatchObject({
            controlId: control!.controlId,
            task: {
              record: {
                id: control!.nativeTaskId,
                kind: 'every',
                everySeconds: 60,
              },
              status: 'active',
            },
          });
          const next = Date.parse(put!.task.record.scheduledAt);
          expect(next).toBe(last + 60_000);
          expect(next).toBeGreaterThan(before);
          // Earlier receipts are kept unless DSH's 30-day retention drops them.
          expect([...history, records.at(-1)].slice(-records.length)).toEqual(
            records,
          );
          await first.stop();
          expect(await run.appended(control!.controlSessionId)).not.toBe('');

          const second = run.open();
          await settle(second);
          await second.stop();
          const receipts = run.memory
            .puts()
            .map(
              ({ task }) => task.deliveryHistory!.records.at(-1)!.scheduledAt,
            );
          expect(new Set(receipts).size).toBe(receipts.length);
          expect(run.memory.released).toEqual([1, 2]);
          await run.appended(control!.controlSessionId);
          expect(await run.history()).toBe(1);
        } finally {
          await run.close();
        }
      }, 60_000);
    },
  );
});
