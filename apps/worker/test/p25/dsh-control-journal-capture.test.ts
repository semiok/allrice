/** Capture the schedule control corpus once per journal contract version
 * (MET-221) into `contract-<current>/control/`, beside the chat corpus of the
 * same version, which must be captured first. Skipped unless run explicitly,
 * after committing the runtime it records, against the fixture database:
 * `ALLRICE_CAPTURE_CONTROL_CORPUS=1 ALLRICE_TEST_DATABASE_URL=postgres://a123@127.0.0.1:5432/allrice_b2 pnpm exec vitest run apps/worker/test/p25/dsh-control-journal-capture.test.ts`
 * The real public Schedule Host of this tree, the production SQL stores and
 * product APIs run in an isolated schema (the fixture needs Vitest); no model,
 * tool or Run executes. An existing control corpus is refused. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { format, resolveConfig } from 'prettier';
import { it, vi } from 'vitest';

import { NATIVE_JOURNAL_CONTRACT } from '../../../../packages/contracts/src/native-journal-contract.ts';
import * as database from '../../../../packages/database/src/index.ts';
import { createP27CodexWorkerFixture } from '../../../../scripts/acceptance/runtime/p27-codex-worker-fixture.ts';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import { measureDshNativeArtifact } from '../../src/harness/dsh-native-artifact.js';
import type { NativeScheduleAnyControl } from '../../src/native-schedule-once.js';
import {
  createNativeOnceControlSource,
  verifyNativeOnceControlHistory,
  type NativeOnceLoaderTestPorts,
} from '../../src/native-schedule-once-loader.js';
import { createNativeOnceWorkerRuntime } from '../../src/native-schedule-once-runtime.js';
import {
  captureControlStore,
  controlCorpusDir,
  controlProfiles,
  type ControlScenario,
  type ControlScenarioId,
  type ControlStoreImage,
} from './control-corpus.js';
import {
  captureSessions,
  corpusRoot,
  normalizedCwd,
} from './journal-corpus.js';

interface ControlSnapshot {
  control: { sessionState: string; at?: string };
  task: {
    lastDelivery?: object;
    deliveryHistory?: { records: object[] };
  } | null;
}
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

const capture =
  process.env.ALLRICE_CAPTURE_CONTROL_CORPUS === '1' ? it : it.skip;

capture(
  'captures one once and one recurring control partition',
  async () => {
    const root = resolve(import.meta.dirname, '../../../..');
    const { current, readsFrom } = NATIVE_JOURNAL_CONTRACT;
    const contractDir = join(corpusRoot, `contract-${current}`);
    // The chat corpus of this version comes first; it refuses an existing dir.
    await access(join(contractDir, 'manifest.json'));
    const output = controlCorpusDir(contractDir);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const uncommitted = git(
      'status',
      '--porcelain',
      '--',
      '.',
      `:!${relative(root, output)}`,
    )
      .split('\n')
      .filter(Boolean);
    await mkdir(output); // refuses an existing control corpus

    vi.stubEnv('ALLRICE_GEMINI_API_ENABLED', '0');
    vi.stubEnv('ALLRICE_ASSISTANTS_ENABLED', '0');
    vi.stubEnv('ALLRICE_NATIVE_ONCE_ENABLED', '1');
    vi.stubEnv('ALLRICE_NATIVE_RECURRING_ENABLED', '1');
    // Production measures format 2; the partitions are born under it.
    const measured = await measureDshNativeArtifact(root, undefined, {
      schemaVersion: 2,
    });
    const controlPorts: NativeOnceLoaderTestPorts = {
      currentArtifact: () => ({
        artifactId: measured.artifactId,
        generation: measured.content.generation,
        root,
        content: measured.content,
      }),
    };
    const fixture = await createP27CodexWorkerFixture({
      allowCiDatabase: true,
      personalProfile: 'writable',
    });
    const scenarios: ControlScenario[] = [];
    const roots: string[] = [];
    try {
      /** One partition: create its tasks, let one fire under a live Host,
       * close, cold restore in a new runtime, close again, then freeze what
       * persisted: the journals and what the next writer reads from SQL. */
      const partition = async (
        id: ControlScenarioId,
        act: (
          tick: () => Promise<void>,
          snapshot: (automationId: string) => Promise<ControlSnapshot>,
        ) => Promise<void>,
      ) => {
        const stateRoot = await realpath(
          await mkdtemp(join(tmpdir(), `allrice-control-corpus-${id}-`)),
        );
        roots.push(stateRoot);
        const reference = {
          artifactId: measured.artifactId,
          profileId: controlProfiles[id],
          storageId: `journal-corpus-${id}`,
          stateRoot,
        };
        vi.stubEnv(
          id === 'once'
            ? 'ALLRICE_NATIVE_ONCE_REFERENCE'
            : 'ALLRICE_NATIVE_RECURRING_REFERENCE',
          JSON.stringify(reference),
        );
        const { partitionId } = await (id === 'once'
          ? database.initializeNativeOncePartition(reference)
          : database.initializeNativeRecurringPartition(reference));
        const source = createNativeOnceControlSource(reference, controlPorts);
        const runtime = () =>
          createNativeOnceWorkerRuntime({
            enabled: true,
            workerId: randomUUID(),
            reference: source.reference,
            loadModules: () => source.loadModules(),
            loadHostFactory: () => source.loadHostFactory(),
          });
        const table =
          id === 'once'
            ? 'allrice_native_once_controls'
            : 'allrice_native_recurring_controls';
        const snapshot = async (automationId: string) => {
          const [row] = await fixture.db<{ snapshot: ControlSnapshot }[]>`
            select snapshot from ${fixture.db(table)} where automation_id=${automationId}`;
          assert(row, `no ${id} control for ${automationId}`);
          return row.snapshot;
        };
        const closed = async () => {
          const [row] = await fixture.db<{ closed: boolean }[]>`
            select closed from allrice_native_once_partitions where partition_id=${partitionId}`;
          assert.equal(row?.closed, true, `${partitionId} did not close`);
        };
        const live = runtime();
        try {
          await act(async () => {
            await live.tick();
            assert.equal(
              live.status().state,
              'active',
              JSON.stringify(live.status()),
            );
          }, snapshot);
        } finally {
          await live.stop();
        }
        await closed();
        const restored = runtime();
        try {
          for (let i = 0; i < 3; i++) {
            await restored.tick();
            await pause(200);
          }
          assert.equal(
            restored.status().state,
            'active',
            JSON.stringify(restored.status()),
          );
        } finally {
          await restored.stop();
        }
        await closed();
        for (const value of [live, restored])
          assert.equal(value.status().controller?.stats.adapterCalls, 0);

        // The production store, as the runtime configures it; this writer is
        // never released, the schema is dropped with the fixture.
        const modules = await source.loadModules();
        const options = {
          db: database.getDatabase(),
          partitionId,
          ownerId: `journal-corpus-${randomUUID()}`,
          reference,
          readiness: () => ({
            enabled: true,
            storageReady: true,
            legacyClockExcluded: true,
            controlArtifactApproved: true,
          }),
          decodeTask: (value: unknown) =>
            modules.schedule.scheduleDomain.tables.tasks.valueSchema.parse(
              value,
            ) as never,
          lockAdmission: database.lockNativeOnceAdmissions,
          proveClosed: async () => null,
        };
        const store =
          id === 'once'
            ? database.createNativeOnceSqlStore(options)
            : database.createNativeRecurringSqlStore({
                ...options,
                lockAdmission: database.lockNativeRecurringAdmissions,
                calendar: {
                  enabled: true,
                  lockAdmission: database.lockNativeCalendarAdmissions,
                },
              });
        const grant = await store.acquireWriter();
        assert(grant, JSON.stringify(store.takeoverRefusal?.()));
        const image: ControlStoreImage = {
          controls: (await store.loadControls(
            grant.writer,
          )) as NativeScheduleAnyControl[],
          tasks: await store.loadTaskRecords(grant.writer),
          workspace: await store.loadWorkspaceUnit(grant.writer),
        };
        const sessions = image.controls.filter(
          (c) => c.sessionState !== 'reserved',
        );
        assert.equal(
          await verifyNativeOnceControlHistory(
            reference,
            image.controls,
            controlPorts,
          ),
          sessions.length,
        );
        const files = await captureSessions(stateRoot, output, id);
        for (const c of sessions)
          assert(
            files.some((file) =>
              file.path.endsWith(`/${c.controlSessionId}/session.v4.jsonl`),
            ),
            `missing journal of ${c.controlSessionId}`,
          );
        scenarios.push({
          id,
          reference: {
            artifactId: reference.artifactId,
            profileId: reference.profileId,
            storageId: reference.storageId,
          },
          files,
          store: await captureControlStore(stateRoot, output, id, image),
        });
      };

      // once: one task fires under the live Host; the other is due only after
      // the capture, so a later replay delivers it on the frozen journal.
      const onceChat = await database.createChatSession(fixture.context, {
        workspaceId: fixture.workspaceId,
        employeeAssignmentId: fixture.assignmentId,
        title: 'Control corpus once',
      });
      const onceTask = (name: string, seconds: number) =>
        database.createOnceTask(fixture.context, onceChat.id, {
          clientRequestId: randomUUID(),
          name,
          prompt: `Control corpus ${name}; no model runs.`,
          runAt: new Date(Date.now() + seconds * 1000).toISOString(),
          timezone: 'Asia/Shanghai',
        });
      let pending: { id: string } | undefined;
      await partition('once', async (tick, snapshot) => {
        const delivered = await onceTask('delivered', 20);
        pending = await onceTask('pending', 120);
        await tick();
        for (const automation of [delivered, pending!])
          assert.equal(
            (await snapshot(automation.id)).control.sessionState,
            'ready',
          );
        const deadline = Date.now() + 40_000;
        while (!(await snapshot(delivered.id)).task?.lastDelivery) {
          assert(Date.now() < deadline, 'the once task did not fire');
          await tick();
          await pause(200);
        }
      });
      const [due] = await fixture.db<{ snapshot: ControlSnapshot }[]>`
        select snapshot from allrice_native_once_controls where automation_id=${pending!.id}`;
      assert(
        !due!.snapshot.task?.lastDelivery &&
          Date.parse(due!.snapshot.control.at!) > Date.now(),
        'the pending once task fired during the capture',
      );

      // recurring: every 60 seconds, delivered once before the first close.
      const recurringChat = await database.createChatSession(fixture.context, {
        workspaceId: fixture.workspaceId,
        employeeAssignmentId: fixture.assignmentId,
        title: 'Control corpus recurring',
      });
      await partition('recurring', async (tick, snapshot) => {
        const recurring = await database.createRecurringTask(
          fixture.context,
          recurringChat.id,
          {
            clientRequestId: randomUUID(),
            name: 'every minute',
            prompt: 'Control corpus every minute; no model runs.',
            rule: { kind: 'every', seconds: 60 },
          },
        );
        await tick();
        const deadline = Date.now() + 90_000;
        while (
          !(await snapshot(recurring.id)).task?.deliveryHistory?.records.length
        ) {
          assert(Date.now() < deadline, 'the recurring task did not fire');
          await tick();
          await pause(200);
        }
      });
    } finally {
      try {
        const cleanup = await fixture.close();
        assert(cleanup.fixture?.schemaRemoved, JSON.stringify(cleanup));
      } finally {
        for (const path of roots)
          await rm(path, { recursive: true, force: true });
        vi.unstubAllEnvs();
      }
    }

    const manifest = {
      capturedWith: {
        allriceCommit: git('rev-parse', 'HEAD'),
        // Anything not yet committed when this corpus was written.
        uncommitted,
        distributionVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        sessionFormat: 4,
        contract: { current, readsFrom },
        // Platform-specific; each partition's reference records it as birth.
        nativeArtifactId: measured.artifactId,
        platform: `${process.platform}-${process.arch} node ${process.version}`,
        store: 'production SQL store in an isolated PostgreSQL schema',
        normalizedCwd,
      },
      scenarios,
    };
    const path = join(output, 'manifest.json');
    const options = { ...(await resolveConfig(path)), filepath: path };
    await writeFile(path, await format(JSON.stringify(manifest), options), {
      flag: 'wx',
    });
  },
  300_000,
);
