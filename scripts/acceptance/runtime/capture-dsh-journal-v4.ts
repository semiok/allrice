/** Capture the DSH journal contract corpus once per contract version (MET-221).
 * Run explicitly with `TSX_TSCONFIG_PATH=tsconfig.base.json pnpm exec tsx`;
 * tests only replay it. An existing corpus directory is refused. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { format, resolveConfig } from 'prettier';

import { NATIVE_JOURNAL_CONTRACT } from '../../../packages/contracts/src/native-journal-contract.ts';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../../apps/worker/src/harness/dsh-distribution.js';
import { measureDshNativeArtifact } from '../../../apps/worker/src/harness/dsh-native-artifact.js';
import {
  captureSessions,
  completedTurn,
  corpusAnswer,
  corpusBootstrap,
  corpusQuestion,
  corpusRoot,
  corpusSessions,
  normalizedCwd,
  until,
  type CorpusScenario,
} from '../../../apps/worker/test/p25/journal-corpus.js';
import { legacySessionFixture } from '../../../apps/worker/test/p25/legacy-session-fixture.js';

const { current, readsFrom } = NATIVE_JOURNAL_CONTRACT;
const output = resolve(
  process.argv[2] ?? join(corpusRoot, `contract-${current}`),
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // refuses an existing corpus
const scenarios: CorpusScenario[] = [];
async function capture(
  fixture: { root: string },
  facts: Omit<CorpusScenario, 'files'>,
) {
  const files = await captureSessions(fixture.root, output, facts.id);
  assert(files.some((file) => file.path.endsWith('/session.v4.jsonl')));
  scenarios.push({ ...facts, files });
}

// (1) A completed Broker tool callback followed by the final answer.
const ordinary = await legacySessionFixture(async (_request, index) =>
  index === 1
    ? {
        nativeTool: {
          name: 'workspace_session_search',
          arguments: { query: 'journal-corpus' },
        },
      }
    : { text: 'Journal tool result recorded.' },
);
try {
  const { client, notices } = await ordinary.runtime([
    'workspace.session.search',
  ]);
  client.setRequestHandler(async (method) => {
    assert.equal(method, 'allrice/tool-call');
    return { modelContent: 'journal-corpus-result' };
  });
  await client.prompt(corpusSessions.ordinary, 'Find the journal corpus once.');
  await completedTurn(notices);
  await client.close();
  assert.equal(ordinary.requests.length, 2);
  await capture(ordinary, {
    id: 'ordinary-tool',
    sessionId: corpusSessions.ordinary,
    toolResult: 'journal-corpus-result',
  });
} finally {
  await ordinary.close();
}

// (2)-(4) One question: parked, answered in another process, then continued.
const question = await legacySessionFixture(async (_request, index) =>
  index === 1
    ? {
        nativeTool: {
          name: 'ask_user_question',
          arguments: { questions: [corpusQuestion] },
        },
      }
    : { text: 'Journal question continued.' },
);
try {
  const sessionId = corpusSessions.question;
  const first = await question.runtime();
  await first.client.prompt(sessionId, 'Ask before continuing the task.');
  await until(() =>
    first.notices.some((n) => n.method === 'session.user-question'),
  );
  const questionId = String(
    first.notices.find((n) => n.method === 'session.user-question')!.params
      .questionId,
  );
  const parked = await first.client.parkQuestion(sessionId, questionId);
  await first.client.close();
  const answer = {
    sessionId,
    questionId,
    turnId: (parked.checkpoint as { turnId: string }).turnId,
    ...corpusAnswer(questionId),
  };
  await capture(question, { id: 'parked-question', sessionId, answer });
  const second = await question.runtime();
  const { proof } = await second.client.answerWait(answer);
  await second.client.close();
  await capture(question, {
    id: 'answered-question',
    sessionId,
    answer,
    proof,
  });
  const third = await question.runtime();
  await third.client.continueWait(answer);
  await completedTurn(third.notices);
  await third.client.close();
  assert.equal(question.requests.length, 2);
  await capture(question, {
    id: 'continued-question',
    sessionId,
    answer,
    reply: 'Journal question continued.',
  });
} finally {
  await question.close();
}

// (5) A bootstrap receipt and a session reference on one prompt.
const bootstrap = await legacySessionFixture(async () => ({
  text: corpusBootstrap.reply,
}));
try {
  const { client, notices } = await bootstrap.runtime();
  const { threadId, receipt, reference, candidates } = corpusBootstrap;
  await client.prompt(
    threadId,
    corpusBootstrap.prompt,
    [],
    [reference],
    receipt,
  );
  await completedTurn(notices);
  const coverage = { scope: receipt.scope, candidates };
  assert.deepEqual(
    (await client.bootstrapCoverage(threadId, coverage)).covered,
    candidates,
  );
  await client.close();
  await capture(bootstrap, {
    id: 'bootstrap-reference',
    sessionId: threadId,
    coverage,
  });
} finally {
  await bootstrap.close();
}

const root = resolve(import.meta.dirname, '../../..');
const manifest = {
  capturedWith: {
    allriceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    distributionVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
    sessionFormat: 4,
    contract: { current, readsFrom },
    // Platform-specific; recorded for provenance, never compared.
    nativeArtifactId: (
      await measureDshNativeArtifact(root, undefined, { schemaVersion: 2 })
    ).artifactId,
    platform: `${process.platform}-${process.arch} node ${process.version}`,
    model: 'synthetic loopback HTTP; no provider credentials',
    normalizedCwd,
  },
  scenarios,
};
const path = join(output, 'manifest.json');
const options = { ...(await resolveConfig(path)), filepath: path };
await writeFile(path, await format(JSON.stringify(manifest), options), {
  flag: 'wx',
});
console.log(`Captured ${scenarios.length} journals in ${output}`);
