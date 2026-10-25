import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type {
  BootstrapCoverageQuery,
  BootstrapReceipt,
  SessionReferenceSnapshot,
} from '@allrice/contracts';

import type { DshNotification } from '../../src/harness/dsh-protocol-client.js';

/** Synthetic inputs of the DSH journal contract corpus (MET-221), shared by
 * scripts/acceptance/runtime/capture-dsh-journal-v4.ts and its replay test.
 * Captured corpora are frozen; a replay reads its facts from the manifest. */
export const corpusRoot = resolve(
  import.meta.dirname,
  '../../src/harness/fixtures/dsh-journal-v4',
);
export const normalizedCwd = '/allrice/journal-fixture';
export const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');
const digest = (value: unknown) => `sha256:${sha256(JSON.stringify(value))}`;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${`${n}`.padStart(12, '0')}`;

export interface CorpusFile {
  path: string;
  sha256: string;
}
export interface CorpusScenario {
  id: string;
  sessionId: string;
  files: CorpusFile[];
  answer?: {
    sessionId: string;
    questionId: string;
    turnId: string;
    inputId: string;
    text: string;
  };
  proof?: object;
  toolResult?: string;
  reply?: string;
  coverage?: BootstrapCoverageQuery;
}

export const corpusSessions = {
  ordinary: `dsh-${uuid(1)}`,
  question: `dsh-${uuid(2)}`,
};
export const corpusQuestion = {
  id: 'choice',
  question: 'Continue the journal task?',
  options: [{ label: 'Continue' }],
};
export const corpusAnswer = (questionId: string) => ({
  inputId: uuid(3),
  text: `allrice:user-question:v1:${JSON.stringify({ questionId, answers: [{ id: corpusQuestion.id, selected: ['Continue'] }] })}`,
});

// A SQL conversation imported into a fresh native session plus one referenced
// session, as the adapter sends them (scope formula: dsh-adapter.ts).
const entry = (role: string, id: string, text: string) => ({
  key: `${role}:${id}`,
  digest: digest({ role, text }),
});
const kernelSessionId = uuid(4);
const threadId = `dsh-${kernelSessionId}`;
const [prompt, reply] = ['按参考资料整理结论。', '已按参考资料整理。'];
const imported = [
  entry('user', uuid(5), '上季度营收是多少？'),
  entry('assistant', uuid(6), '上季度营收 1200 万。'),
];
const userMessage = entry('user', uuid(7), prompt);
export const corpusBootstrap = {
  threadId,
  prompt,
  reply,
  receipt: {
    version: 1,
    scope: digest([kernelSessionId, threadId, null]),
    imported,
    userMessage,
    assistantMessageId: uuid(8),
  } satisfies BootstrapReceipt,
  reference: {
    sessionId: uuid(9),
    label: '财报研究',
    visibility: 'private',
    capturedAt: '2026-10-25T00:00:00.000Z',
    checksum: `sha256:${'b'.repeat(64)}`,
    originalMessages: 1,
    truncated: false,
    messages: [
      {
        id: uuid(10),
        role: 'assistant',
        text: '结论：营收同比增长 20%。',
        createdAt: '2026-10-24T00:00:00.000Z',
      },
    ],
  } satisfies SessionReferenceSnapshot,
  candidates: [...imported, userMessage, entry('assistant', uuid(8), reply)],
};

const encoded = (path: string) => path.replaceAll('/', '-');

/** Copy every session file of a disposable root. Only the cwd is normalized,
 * in contents and in DSH's cwd-derived directory name (and its realpath form). */
export async function captureSessions(
  root: string,
  output: string,
  scenario: string,
) {
  const forms = [...new Set([await realpath(root), root])].sort(
    (a, b) => b.length - a.length,
  );
  const normalize = (text: string) =>
    forms.reduce(
      (value, form) =>
        value
          .replaceAll(form, normalizedCwd)
          .replaceAll(encoded(form), encoded(normalizedCwd)),
      text,
    );
  const sessions = join(root, 'sessions');
  const files: CorpusFile[] = [];
  for (const entry of await readdir(sessions, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const source = join(entry.parentPath, entry.name);
    const path = join(scenario, normalize(relative(sessions, source)));
    const text = normalize(await readFile(source, 'utf8'));
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), text, { flag: 'wx' });
    files.push({ path, sha256: sha256(text) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Install frozen files under a disposable root at the cwd DSH will derive. */
export async function installSessions(
  corpus: string,
  scenario: CorpusScenario,
  root: string,
) {
  for (const file of scenario.files) {
    const text = await readFile(join(corpus, file.path), 'utf8');
    if (sha256(text) !== file.sha256)
      throw new Error(`Corpus file changed: ${file.path}`);
    const target = join(
      root,
      'sessions',
      relative(scenario.id, file.path).replace(
        encoded(normalizedCwd),
        encoded(root),
      ),
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text.replaceAll(normalizedCwd, root));
  }
}

export async function until(check: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for DSH');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** idle also follows a failed turn; require a completed turn after `from`. */
export async function completedTurn(notices: DshNotification[], from = 0) {
  await until(() =>
    notices
      .slice(from)
      .some((n) => n.method === 'session.status' && n.params.status === 'idle'),
  );
  const end = notices
    .slice(from)
    .map((n) => n.params.event as { type?: string; data?: object } | undefined)
    .findLast((event) => event?.type === 'turn/end') as
    { data: { reason?: { kind?: string } } } | undefined;
  if (end?.data.reason?.kind !== 'completed')
    throw new Error(`DSH turn did not complete: ${JSON.stringify(end)}`);
}
