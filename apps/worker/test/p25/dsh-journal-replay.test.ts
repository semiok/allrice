import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NATIVE_JOURNAL_CONTRACT } from '../../../../packages/contracts/src/native-journal-contract.ts';
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
const readable = corpora.filter(({ version }) => version >= readsFrom);
type Corpus = (typeof corpora)[number];

/** Install one frozen journal into a fresh root and recover it with the
 * installed runtime; a recorded tool must never be dispatched again. */
async function replay(corpus: Corpus, id: string, text: string) {
  const scenario = corpus.scenario(id);
  const fixture = await legacySessionFixture(async () => ({ text }));
  try {
    await installSessions(corpus.dir, scenario, fixture.root);
    const { client, notices } = await fixture.runtime();
    client.setRequestHandler(async () => {
      throw new Error('Recorded tools must never be dispatched again');
    });
    await expect(client.recover(scenario.sessionId)).resolves.toMatchObject({
      recovered: true,
    });
    // One completed model turn; returns what the model was sent.
    const settle = async (action: Promise<unknown>) => {
      const from = notices.length;
      await action;
      await completedTurn(notices, from);
      expect(fixture.requests).toHaveLength(1);
      return JSON.stringify(fixture.requests[0]!.messages);
    };
    return { client, fixture, scenario, settle };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

// Every corpus of a contract version this build still reads (MET-221). Each
// raise of `current` adds a corpus captured by capture-dsh-journal-v4.ts.
describe('DSH journal contract corpus', () => {
  it('keeps one corpus for every readable contract version', () => {
    for (const { name, version } of corpora)
      expect(name).toBe(`contract-${version}`);
    expect(
      readable.map(({ version }) => version).sort((a, b) => a - b),
    ).toEqual(
      Array.from({ length: current - readsFrom + 1 }, (_, i) => readsFrom + i),
    );
  });

  describe.each(readable.map((corpus) => [corpus.name, corpus] as const))(
    '%s under the installed runtime',
    (_name, corpus) => {
      it('continues after a recorded tool turn without dispatching the tool again', async () => {
        const run = await replay(corpus, 'ordinary-tool', 'Replay after tool.');
        try {
          const sent = await run.settle(
            run.client.prompt(run.scenario.sessionId, 'Continue.'),
          );
          expect(sent).toContain(run.scenario.toolResult);
          expect(
            run.fixture.requests[0]!.messages.filter((m) => m.role === 'tool'),
          ).toHaveLength(1);
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
            const { proof } = corpus.scenario('answered-question');
            // A repeated answer is idempotent and dispatches no model.
            for (let attempt = 0; attempt < 2; attempt++)
              expect((await run.client.answerWait(answer)).proof).toEqual(
                proof,
              );
            expect(run.fixture.requests).toHaveLength(0);
            expect(await run.settle(run.client.continueWait(answer))).toContain(
              'Continue',
            );
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
          const sent = await run.settle(
            run.client.prompt(run.scenario.sessionId, 'Next?'),
          );
          expect(sent).toContain(run.scenario.reply);
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
          await run.client.close();
          const references = (await run.fixture.logs())
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter(
              (event) =>
                event.type === 'user/message' &&
                event.data.source.kind === 'session-reference',
            );
          expect(references).toHaveLength(1);
        } finally {
          await run.fixture.close();
        }
      }, 30_000);
    },
  );
});
