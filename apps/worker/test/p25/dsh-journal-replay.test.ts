import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NATIVE_JOURNAL_CONTRACT } from '../../../../packages/contracts/src/native-journal-contract.ts';
import { latestTaskMessage } from '../p24/fixture.js';
import {
  completedTurn,
  corpusRoot,
  installSessions,
  type CorpusScenario,
} from './journal-corpus.js';
import { legacySessionFixture } from './legacy-session-fixture.js';

const { current, readsFrom } = NATIVE_JOURNAL_CONTRACT;
const corpora = await Promise.all(
  (await readdir(corpusRoot))
    .filter((name) => /^contract-\d+$/.test(name))
    .map(async (name) => {
      const dir = join(corpusRoot, name);
      const manifest = JSON.parse(
        await readFile(join(dir, 'manifest.json'), 'utf8'),
      ) as {
        capturedWith: { contract: { current: number } };
        scenarios: CorpusScenario[];
      };
      const scenario = (id: string) =>
        manifest.scenarios.find((item) => item.id === id)!;
      const version = manifest.capturedWith.contract.current;
      return { dir, name, version, scenario };
    }),
);
type Corpus = (typeof corpora)[number];

/** Install one frozen journal into a fresh root and recover it with the
 * installed runtime and the tools it was recorded with. */
async function replay(corpus: Corpus, id: string, text: string) {
  const scenario = corpus.scenario(id);
  const fixture = await legacySessionFixture(async () => ({ text }));
  // A recorded tool must never be dispatched again; the client turns a
  // throwing handler into a JSON-RPC error, so count the calls instead.
  const dispatched: string[] = [];
  const open = async () => {
    const runtime = await fixture.runtime(scenario.nativeTools);
    runtime.client.setRequestHandler(async (method) => {
      dispatched.push(method);
      throw new Error('Recorded tools must never be dispatched again');
    });
    await expect(
      runtime.client.recover(scenario.sessionId),
    ).resolves.toMatchObject({ recovered: true });
    return runtime;
  };
  try {
    await installSessions(corpus.dir, scenario, fixture.root);
    const { client, notices } = await open();
    // One completed model turn; returns what the model was sent.
    const settle = async (action: Promise<unknown>) => {
      const from = notices.length;
      await action;
      await completedTurn(notices, from);
      expect(fixture.requests).toHaveLength(1);
      const [request] = fixture.requests;
      const last = latestTaskMessage(request!)?.content;
      return {
        sent: JSON.stringify(request!.messages),
        last: typeof last === 'string' ? last : JSON.stringify(last),
      };
    };
    // A later process must read back what this build appended.
    const reopen = async () => {
      await client.close();
      const next = await open();
      const log = await fixture.logs();
      expect(log).toContain(text);
      return { ...next, log };
    };
    return { client, fixture, scenario, settle, reopen, dispatched };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

// Every corpus of a contract version this build still reads (MET-221). Each
// raise of `current` adds a corpus captured by capture-dsh-journal-v4.ts.
describe('DSH journal contract corpus', () => {
  it('keeps one corpus for every readable contract version', () => {
    for (const { name, version } of corpora) {
      expect(name).toBe(`contract-${version}`);
      // Raising readsFrom retires the older corpora with their descriptors.
      expect(version).toBeGreaterThanOrEqual(readsFrom);
    }
    expect(corpora.map(({ version }) => version).sort((a, b) => a - b)).toEqual(
      Array.from({ length: current - readsFrom + 1 }, (_, i) => readsFrom + i),
    );
  });

  describe.each(corpora.map((corpus) => [corpus.name, corpus] as const))(
    '%s under the installed runtime',
    (_name, corpus) => {
      it('refuses a one-byte edit before installing the changed journal', async () => {
        const root = await mkdtemp(join(tmpdir(), 'allrice-corpus-integrity-'));
        try {
          const scenario = corpus.scenario('ordinary-tool');
          const file = scenario.files.find((item) =>
            item.path.endsWith('/session.v4.jsonl'),
          )!;
          const bytes = await readFile(join(corpus.dir, file.path));
          bytes[0] = bytes[0]! ^ 1;
          const copy = join(root, 'corpus', file.path);
          await mkdir(dirname(copy), { recursive: true });
          await writeFile(copy, bytes);
          await expect(
            installSessions(
              join(root, 'corpus'),
              { ...scenario, files: [file] },
              join(root, 'target'),
            ),
          ).rejects.toThrow(`Corpus file changed: ${file.path}`);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });

      it('continues after a recorded tool turn without dispatching the tool again', async () => {
        const run = await replay(corpus, 'ordinary-tool', 'Replay after tool.');
        try {
          const { sent } = await run.settle(
            run.client.prompt(run.scenario.sessionId, 'Continue.'),
          );
          expect(sent).toContain(run.scenario.toolResult);
          expect(
            run.fixture.requests[0]!.messages.filter((m) => m.role === 'tool'),
          ).toHaveLength(1);
          await run.reopen();
          expect(run.dispatched).toEqual([]);
        } finally {
          await run.fixture.close();
        }
      }, 30_000);

      it.each(['parked-question', 'answered-question'])(
        'answers %s with the recorded proof once, then continues it',
        async (id) => {
          const run = await replay(corpus, id, 'Replay continued.');
          try {
            const answer = run.scenario.answer!;
            const recorded = corpus.scenario('answered-question').proof;
            // A parked wait is answered now: its sequence depends on what
            // this build appends on open, the rest of the proof does not.
            const { proof } = await run.client.answerWait(answer);
            expect(proof).toEqual(
              id === 'parked-question'
                ? { ...recorded, sequence: expect.any(Number) }
                : recorded,
            );
            // A repeated answer is idempotent and dispatches no model.
            expect((await run.client.answerWait(answer)).proof).toEqual(proof);
            expect(run.fixture.requests).toHaveLength(0);
            const { last } = await run.settle(run.client.continueWait(answer));
            const { answers } = JSON.parse(
              answer.text.replace(/^allrice:user-question:v\d+:/, ''),
            );
            expect(last).toContain(JSON.stringify(answers));
            const next = await run.reopen();
            await expect(next.client.continueWait(answer)).rejects.toThrow(
              'NATIVE_WAIT_CHANGED',
            );
            expect(run.dispatched).toEqual([]);
          } finally {
            await run.fixture.close();
          }
        },
        30_000,
      );

      it('starts a new turn after a continued question and never continues it twice', async () => {
        const run = await replay(corpus, 'continued-question', 'Next.');
        try {
          await expect(
            run.client.continueWait(run.scenario.answer!),
          ).rejects.toThrow('NATIVE_WAIT_CHANGED');
          const { sent } = await run.settle(
            run.client.prompt(run.scenario.sessionId, 'Next?'),
          );
          expect(sent).toContain(run.scenario.reply);
          const next = await run.reopen();
          await expect(
            next.client.continueWait(run.scenario.answer!),
          ).rejects.toThrow('NATIVE_WAIT_CHANGED');
          expect(run.dispatched).toEqual([]);
        } finally {
          await run.fixture.close();
        }
      }, 30_000);

      it('keeps bootstrap coverage and the session reference without injecting it again', async () => {
        const run = await replay(corpus, 'bootstrap-reference', 'Again.');
        try {
          const { coverage, sessionId } = run.scenario;
          expect(
            (await run.client.bootstrapCoverage(sessionId, coverage!)).covered,
          ).toEqual(coverage!.candidates);
          await run.settle(run.client.prompt(sessionId, 'Continue.'));
          expect(
            run.fixture.requests[0]!.messages.filter((m) =>
              JSON.stringify(m.content).includes('Referenced sessions'),
            ),
          ).toHaveLength(1);
          const next = await run.reopen();
          expect(
            (await next.client.bootstrapCoverage(sessionId, coverage!)).covered,
          ).toEqual(coverage!.candidates);
          const references = next.log
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter(
              (event) =>
                event.type === 'user/message' &&
                event.data.source.kind === 'session-reference',
            );
          expect(references).toHaveLength(1);
          expect(run.dispatched).toEqual([]);
        } finally {
          await run.fixture.close();
        }
      }, 30_000);
    },
  );
});
