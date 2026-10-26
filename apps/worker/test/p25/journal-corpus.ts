import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import type { BootstrapCoverageQuery } from '@allrice/contracts';

import type { DshNotification } from '../../src/harness/dsh-protocol-client.js';

/** Shared by scripts/acceptance/runtime/capture-dsh-journal-v4.ts and the
 * replay test of the DSH journal contract corpus (MET-221), and by the schedule
 * control corpus (control-corpus.ts). Captured corpora
 * are frozen; a replay reads every fact it needs from the manifest. */
export const corpusRoot = resolve(
  import.meta.dirname,
  '../../src/harness/fixtures/dsh-journal-v4',
);
export const normalizedCwd = '/allrice/journal-fixture';
export const sha256 = (text: string) =>
  createHash('sha256').update(text).digest('hex');

export interface CorpusFile {
  path: string;
  sha256: string;
}
export interface CorpusScenario {
  id: string;
  sessionId: string;
  nativeTools: string[];
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

/** The project directory DSH derives from a session's recorded cwd and checks
 * on open; mirrors the unexported projectKey of
 * @deepseek-ai/dsh-session-persistence-jsonl. Capture asserts it matches. */
export function projectKey(cwd: string) {
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]!; // UTF-16 code units, as upstream
    if ('/\\:'.includes(ch)) {
      if (!separatorRun) readable += '-';
      separatorRun = true;
      continue;
    }
    separatorRun = false;
    readable +=
      ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
        ? ch
        : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** Copy the session files of a disposable root; DSH recreates its lock file.
 * Only the cwd is normalized: in contents, and as the project directory. */
export async function captureSessions(
  root: string,
  output: string,
  scenario: string,
) {
  const forms = [...new Set([await realpath(root), root])].sort(
    (a, b) => b.length - a.length,
  );
  const normalize = (text: string) =>
    forms.reduce((value, form) => value.replaceAll(form, normalizedCwd), text);
  const sessions = join(root, 'sessions');
  const files: CorpusFile[] = [];
  for (const entry of await readdir(sessions, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || entry.name === 'session.lock') continue;
    const source = join(entry.parentPath, entry.name);
    const [project, ...rest] = relative(sessions, source).split(sep);
    if (!forms.some((form) => projectKey(form) === project))
      throw new Error(`Unexpected DSH project directory: ${project}`);
    const path = join(scenario, projectKey(normalizedCwd), ...rest);
    const text = normalize(await readFile(source, 'utf8'));
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), text, { flag: 'wx' });
    files.push({ path, sha256: sha256(text) });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Install frozen files under a disposable root at the cwd DSH will derive. */
export async function installSessions(
  corpus: string,
  scenario: Pick<CorpusScenario, 'id' | 'files'>,
  root: string,
) {
  for (const file of scenario.files) {
    const text = await readFile(join(corpus, file.path), 'utf8');
    if (sha256(text) !== file.sha256)
      throw new Error(`Corpus file changed: ${file.path}`);
    const [, ...rest] = relative(scenario.id, file.path).split(sep);
    const target = join(root, 'sessions', projectKey(root), ...rest);
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
