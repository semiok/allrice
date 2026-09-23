/** Capture synthetic historical bytes explicitly; never regenerate on test runs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../../apps/worker/src/harness/dsh-distribution.js';
import {
  legacySessionFixture,
  waitForLegacyNotice,
} from '../../../apps/worker/test/p25/legacy-session-fixture.js';

assert.equal(DSH_DISTRIBUTION_CURRENT_VERSION, '0.1.1-rc.2');
assert(
  process.argv[2],
  'Pass a new output directory; existing files are refused',
);
const output = resolve(process.argv[2]);
await mkdir(output, { recursive: false });
const files: { file: string; sha256: string; sessionId: string }[] = [];
const answerId = '11111111-1111-4111-8111-111111111111';

async function capture(
  file: string,
  fixture: Awaited<ReturnType<typeof legacySessionFixture>>,
  sessionId: string,
) {
  // Only normalize the disposable cwd. Preserve physical rows, seqs, ids,
  // timestamps, packed chunks and private event payloads produced by DSH.
  const text = (await fixture.logs()).replaceAll(
    fixture.root,
    '/allrice/legacy-fixture',
  );
  await writeFile(resolve(output, file), text, { flag: 'wx' });
  files.push({
    file,
    sha256: createHash('sha256').update(text).digest('hex'),
    sessionId,
  });
}

const ordinary = await legacySessionFixture(async (_request, index) =>
  index === 1
    ? {
        nativeTool: {
          name: 'workspace_session_search',
          arguments: { query: 'synthetic-history' },
        },
      }
    : { text: 'Historical tool result recorded.' },
);
try {
  const { client, notices } = await ordinary.runtime([
    'workspace.session.search',
  ]);
  client.setRequestHandler(async (method) => {
    assert.equal(method, 'allrice/tool-call');
    return { modelContent: 'synthetic-history-result' };
  });
  const sessionId = 'legacy-ordinary-tool';
  await client.prompt(sessionId, 'Find the synthetic history once.');
  await waitForLegacyNotice(() =>
    notices.some(
      (n) => n.method === 'session.status' && n.params.status === 'idle',
    ),
  );
  await client.close();
  assert.equal(ordinary.requests.length, 2);
  await capture('ordinary-tool.jsonl', ordinary, sessionId);
} finally {
  await ordinary.close();
}

const question = await legacySessionFixture(async (_request, index) =>
  index === 1
    ? {
        nativeTool: {
          name: 'ask_user_question',
          arguments: {
            questions: [
              {
                id: 'choice',
                question: 'Continue the synthetic task?',
                options: [{ label: 'Continue' }],
              },
            ],
          },
        },
      }
    : { text: 'Historical continuation completed.' },
);
try {
  const { client, notices } = await question.runtime();
  const sessionId = 'legacy-question';
  await client.prompt(sessionId, 'Ask before continuing the synthetic task.');
  await waitForLegacyNotice(() =>
    notices.some((n) => n.method === 'session.user-question'),
  );
  const questionId = String(
    notices.find((n) => n.method === 'session.user-question')!.params
      .questionId,
  );
  const parked = await client.parkQuestion(sessionId, questionId);
  const turnId = (parked.checkpoint as { turnId: string }).turnId;
  await client.close();
  await capture('parked-question.jsonl', question, sessionId);
  const recovered = await question.runtime();
  const answer = {
    sessionId,
    questionId,
    turnId,
    inputId: answerId,
    text: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: [{ id: 'choice', selected: ['Continue'] }] })}`,
  };
  await recovered.client.answerWait(answer);
  await capture('answered-question.jsonl', question, sessionId);
  await recovered.client.continueWait(answer);
  await waitForLegacyNotice(() =>
    recovered.notices.some(
      (n) => n.method === 'session.status' && n.params.status === 'idle',
    ),
  );
  await recovered.client.close();
  assert.equal(question.requests.length, 2);
  await capture('continued-question.jsonl', question, sessionId);
} finally {
  await question.close();
}
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify(
    {
      capturedWith: {
        allriceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        upstreamVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        upstreamCommit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
        sessionFormat: 0,
        model: 'synthetic loopback HTTP; no provider credentials',
        normalizedCwd: '/allrice/legacy-fixture',
      },
      answerId,
      files,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
console.log(`Captured ${files.length} synthetic legacy journals in ${output}`);
