/** Capture the DSH journal contract corpus once per contract version (MET-221).
 * Run explicitly with `TSX_TSCONFIG_PATH=tsconfig.base.json pnpm exec tsx`
 * after committing the runtime it records; tests only replay it. An existing
 * corpus directory is refused. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { format, resolveConfig } from 'prettier';

import { NATIVE_JOURNAL_CONTRACT } from '../../../packages/contracts/src/native-journal-contract.ts';
import { bootstrapContextForCheckpoint } from '../../../apps/worker/src/employee-kernel.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../../apps/worker/src/harness/dsh-distribution.js';
import { measureDshNativeArtifact } from '../../../apps/worker/src/harness/dsh-native-artifact.js';
import {
  captureSessions,
  completedTurn,
  corpusRoot,
  normalizedCwd,
  until,
  type CorpusScenario,
} from '../../../apps/worker/test/p25/journal-corpus.js';
import { legacySessionFixture } from '../../../apps/worker/test/p25/legacy-session-fixture.js';

const root = resolve(import.meta.dirname, '../../..');
const { current, readsFrom } = NATIVE_JOURNAL_CONTRACT;
const output = resolve(
  process.argv[2] ?? join(corpusRoot, `contract-${current}`),
);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // refuses an existing corpus
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${`${n}`.padStart(12, '0')}`;
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
  const sessionId = `dsh-${uuid(1)}`;
  const nativeTools = ['workspace.session.search'];
  const { client, notices } = await ordinary.runtime(nativeTools);
  client.setRequestHandler(async (method) => {
    assert.equal(method, 'allrice/tool-call');
    return { modelContent: 'journal-corpus-result' };
  });
  await client.prompt(sessionId, 'Find the journal corpus once.');
  await completedTurn(notices);
  await client.close();
  assert.equal(ordinary.requests.length, 2);
  await capture(ordinary, {
    id: 'ordinary-tool',
    sessionId,
    nativeTools,
    toolResult: 'journal-corpus-result',
  });
} finally {
  await ordinary.close();
}

// (2)-(4) One question: parked, answered in another process, then continued.
const choice = {
  id: 'choice',
  question: 'Continue the journal task?',
  options: [{ label: 'Continue' }],
};
const question = await legacySessionFixture(async (_request, index) =>
  index === 1
    ? {
        nativeTool: {
          name: 'ask_user_question',
          arguments: { questions: [choice] },
        },
      }
    : { text: 'Journal question continued.' },
);
try {
  const sessionId = `dsh-${uuid(2)}`;
  const facts = { sessionId, nativeTools: [] };
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
  const answers = [{ id: choice.id, selected: ['Continue'] }];
  const answer = {
    sessionId,
    questionId,
    turnId: (parked.checkpoint as { turnId: string }).turnId,
    inputId: uuid(3),
    text: `allrice:user-question:v1:${JSON.stringify({ questionId, answers })}`,
  };
  await capture(question, { id: 'parked-question', ...facts, answer });
  const second = await question.runtime();
  const { proof } = await second.client.answerWait(answer);
  await second.client.close();
  await capture(question, { id: 'answered-question', ...facts, answer, proof });
  const third = await question.runtime();
  await third.client.continueWait(answer);
  await completedTurn(third.notices);
  await third.client.close();
  assert.equal(question.requests.length, 2);
  await capture(question, {
    id: 'continued-question',
    ...facts,
    answer,
    proof,
    reply: 'Journal question continued.',
  });
} finally {
  await question.close();
}

// (5) A SQL conversation with a checkpoint imported into a fresh native
// session, plus a session reference, as the adapter sends them.
const kernelSessionId = uuid(4);
const threadId = `dsh-${kernelSessionId}`;
const prompt = '按参考资料整理结论。';
const reply = '已按参考资料整理。';
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const context = bootstrapContextForCheckpoint(
  [
    { id: uuid(5), role: 'user', text: '上季度营收是多少？' },
    { id: uuid(6), role: 'assistant', text: '上季度营收 1200 万。' },
    { id: uuid(7), role: 'user', text: '同比呢？' },
  ] as never,
  {
    summaryVersion: 'extractive-v1',
    generation: 1,
    coveredThroughMessageId: uuid(6),
    summary: '用户在问上季度营收，答案是 1200 万。',
  } as never,
)!;
const receipt = {
  version: 1 as const,
  scope: digest([kernelSessionId, threadId, null]),
  imported: context.segments.map(({ key, digest }) => ({ key, digest })),
  userMessage: {
    key: `user:${uuid(8)}`,
    digest: digest({ role: 'user', text: prompt }),
  },
  assistantMessageId: uuid(9),
};
const bootstrap = await legacySessionFixture(async () => ({ text: reply }));
try {
  const { client, notices } = await bootstrap.runtime();
  // The adapter prompts with the uncovered context, then the user request.
  const text = `Conversation context:\n${context.segments.map((s) => s.text).join('\n')}\n\n${prompt}`;
  await client.prompt(
    threadId,
    text,
    [],
    [
      {
        sessionId: uuid(10),
        label: '财报研究',
        visibility: 'private',
        capturedAt: '2026-10-25T00:00:00.000Z',
        checksum: `sha256:${'b'.repeat(64)}`,
        originalMessages: 1,
        truncated: false,
        messages: [
          {
            id: uuid(11),
            role: 'assistant',
            text: '结论：营收同比增长 20%。',
            createdAt: '2026-10-24T00:00:00.000Z',
          },
        ],
      },
    ],
    receipt,
  );
  await completedTurn(notices);
  const candidates = [
    ...receipt.imported,
    receipt.userMessage,
    {
      key: `assistant:${receipt.assistantMessageId}`,
      digest: digest({ role: 'assistant', text: reply }),
    },
  ];
  const coverage = { scope: receipt.scope, candidates };
  assert.deepEqual(
    (await client.bootstrapCoverage(threadId, coverage)).covered,
    candidates,
  );
  await client.close();
  await capture(bootstrap, {
    id: 'bootstrap-reference',
    sessionId: threadId,
    nativeTools: [],
    coverage,
  });
} finally {
  await bootstrap.close();
}

const manifest = {
  capturedWith: {
    allriceCommit: git('rev-parse', 'HEAD'),
    // Anything not yet committed when this corpus was written.
    uncommitted: git(
      'status',
      '--porcelain',
      '--',
      '.',
      `:!${relative(root, output)}`,
    )
      .split('\n')
      .filter(Boolean),
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
