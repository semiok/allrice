import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { legacySessionFixture } from './legacy-session-fixture.js';
import manifest from '../../src/harness/fixtures/dsh-legacy-v0/manifest.json' with { type: 'json' };

const fixtureRoot = resolve(
  import.meta.dirname,
  '../../src/harness/fixtures/dsh-legacy-v0',
);

async function journal(file: string) {
  const entry = manifest.files.find((entry) => entry.file === file)!;
  const text = await readFile(join(fixtureRoot, file), 'utf8');
  expect(createHash('sha256').update(text).digest('hex')).toBe(entry.sha256);
  return { text, sessionId: entry.sessionId };
}

// DSH derives the storage directory from the session's recorded cwd.
async function install(
  root: string,
  sessionId: string,
  text: string,
  cwd = manifest.capturedWith.normalizedCwd,
  name = 'session.jsonl',
) {
  const path = join(
    root,
    'sessions',
    `-${cwd.replaceAll('/', '-')}--`,
    sessionId,
    name,
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

function rows(text: string) {
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

// Every file under the session root, so a substitute written anywhere shows up.
async function sessionFiles(root: string) {
  const entries = await readdir(join(root, 'sessions'), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

const mutations = {
  // A v0 file name whose header claims another format: a corrupt log.
  'mismatched-header': { version: 999, name: 'session.jsonl' },
  // A generation written by a newer harness.
  'future-format': { version: 999, name: 'session.v999.jsonl' },
  'unknown-required-event': { name: 'session.jsonl' },
} as const;

function mutate(text: string, kind: keyof typeof mutations) {
  const events = rows(text);
  if (kind === 'unknown-required-event')
    events[1].type = 'allrice/unknown-required-fixture';
  else events[0].version = mutations[kind].version;
  return events.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

// AllRice runs one DSH generation. An older journal either moves forward through
// DSH's own format migrators or is refused; nothing reads it with old code.
describe('DSH historical sessions under the installed generation', () => {
  it('forwards an ordinary historical journal with the official migrators and keeps its bytes', async () => {
    const fixture = await legacySessionFixture(async () => ({
      text: 'Legacy history retained.',
    }));
    try {
      const old = await journal('ordinary-tool.jsonl');
      // The corpus normalized its capture directory; a migrated session keeps
      // its recorded working directory, so point it at this disposable root.
      const text = old.text.replaceAll(
        manifest.capturedWith.normalizedCwd,
        fixture.root,
      );
      const path = await install(
        fixture.root,
        old.sessionId,
        text,
        fixture.root,
      );
      const { client, notices } = await fixture.runtime();
      const callbacks: string[] = [];
      client.setRequestHandler(async (method) => {
        callbacks.push(method);
        throw new Error('Historical tools must never be dispatched');
      });
      await expect(client.recover(old.sessionId)).resolves.toMatchObject({
        recovered: true,
      });
      expect(fixture.requests).toHaveLength(0);
      const migrated = rows(
        await readFile(join(dirname(path), 'session.v4.jsonl'), 'utf8'),
      );
      expect(migrated[0]).toMatchObject({ type: 'session', version: 4 });
      const original = rows(text);
      for (const type of ['user/message', 'tool/call', 'tool/result'])
        expect(migrated.filter((event) => event.type === type)).toHaveLength(
          original.filter((event) => event.type === type).length,
        );
      // The next turn sees the migrated history, including the completed tool
      // result, without dispatching the historical tool again.
      const before = notices.length;
      await client.prompt(old.sessionId, 'Continue from history.');
      await expect
        .poll(() =>
          notices
            .slice(before)
            .some(
              (n) =>
                n.method === 'session.status' && n.params.status === 'idle',
            ),
        )
        .toBe(true);
      // idle also follows a failed turn; require the new reply and completion.
      const turn = notices
        .slice(before)
        .filter((n) => n.method === 'session.event')
        .map((n) => n.params.event as { type: string; data: unknown });
      expect(
        turn
          .filter((event) => event.type === 'assistant/message')
          .map((event) => JSON.stringify(event.data)),
      ).toEqual([expect.stringContaining('Legacy history retained.')]);
      expect(turn.find((event) => event.type === 'turn/end')?.data).toEqual(
        expect.objectContaining({ reason: { kind: 'completed' } }),
      );
      expect(fixture.requests).toHaveLength(1);
      expect(callbacks).toEqual([]);
      const messages = fixture.requests[0]!.messages;
      expect(JSON.stringify(messages)).toContain('synthetic-history-result');
      expect(JSON.stringify(messages)).toContain(
        'Historical tool result recorded.',
      );
      expect(
        messages.filter((message) => message.role === 'tool'),
      ).toHaveLength(1);
      await client.close();
      expect(await readFile(path, 'utf8')).toBe(text);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  // Private AllRice events are unknown to the official migrators (MET-221).
  it.each([
    ...manifest.files
      .filter((entry) => entry.file !== 'ordinary-tool.jsonl')
      .map(
        (entry) =>
          [
            entry.file,
            entry.file,
            /unknown historical event type "allrice\/wait\/checkpoint"/,
          ] as const,
      ),
    [
      'mismatched-header',
      'ordinary-tool.jsonl',
      /generation filename identifies v0, but its header identifies v999/,
    ] as const,
    [
      'future-format',
      'ordinary-tool.jsonl',
      /uses log format v999, but this harness reads only v4/,
    ] as const,
    [
      'unknown-required-event',
      'ordinary-tool.jsonl',
      /unknown historical event type "allrice\/unknown-required-fixture"/,
    ] as const,
  ])(
    'candidate refuses historical %s instead of rewriting it or creating an empty substitute',
    async (kind, file, reason) => {
      const fixture = await legacySessionFixture(async () => ({
        text: 'Unexpected',
      }));
      try {
        const old = await journal(file);
        const mutation =
          kind in mutations ? (kind as keyof typeof mutations) : null;
        const text = mutation ? mutate(old.text, mutation) : old.text;
        const path = await install(
          fixture.root,
          old.sessionId,
          text,
          undefined,
          mutation ? mutations[mutation].name : undefined,
        );
        const installed = await sessionFiles(fixture.root);
        const { client } = await fixture.runtime();
        const refused = await client.recover(old.sessionId).then(
          () => null,
          (error: unknown) => error as { code?: string; message: string },
        );
        expect(refused?.code).toBe('DSH_REQUEST_FAILED');
        expect(refused?.message).toMatch(reason);
        await client.close();
        expect(fixture.requests).toHaveLength(0);
        expect(await readFile(path, 'utf8')).toBe(text);
        expect(await sessionFiles(fixture.root)).toEqual(installed);
      } finally {
        await fixture.close();
      }
    },
    30_000,
  );
});
