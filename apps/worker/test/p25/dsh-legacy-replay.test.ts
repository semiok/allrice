import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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

async function install(root: string, sessionId: string, text: string) {
  const path = join(
    root,
    'sessions',
    '--allrice-legacy-fixture--',
    sessionId,
    'session.jsonl',
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

function mutate(
  text: string,
  kind: 'future-format' | 'unknown-required-event',
) {
  const rows = text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (kind === 'future-format') rows[0].version = 999;
  else rows[1].type = 'allrice/unknown-required-fixture';
  return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

// AllRice runs one DSH generation. An older journal either moves forward through
// DSH's own format migrators or is refused; nothing reads it with old code.
describe('DSH historical sessions under the installed generation', () => {
  it('forwards an ordinary historical journal with the official migrators and keeps its bytes', async () => {
    const fixture = await legacySessionFixture(async () => ({
      text: 'Unexpected',
    }));
    try {
      const old = await journal('ordinary-tool.jsonl');
      const path = await install(fixture.root, old.sessionId, old.text);
      const { client } = await fixture.runtime();
      await expect(client.recover(old.sessionId)).resolves.toMatchObject({
        recovered: true,
      });
      expect(fixture.requests).toHaveLength(0);
      expect(await readFile(path, 'utf8')).toBe(old.text);
      const migrated = (
        await readFile(join(dirname(path), 'session.v4.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(migrated[0]).toMatchObject({ type: 'session', version: 4 });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  // Private AllRice events are unknown to the official migrators (MET-221).
  it.each([
    ...manifest.files
      .filter((entry) => entry.file !== 'ordinary-tool.jsonl')
      .map((entry) => [entry.file, entry.file] as const),
    ['future-format', 'ordinary-tool.jsonl'] as const,
    ['unknown-required-event', 'ordinary-tool.jsonl'] as const,
  ])(
    'candidate refuses historical %s instead of rewriting it or creating an empty substitute',
    async (kind, file) => {
      const fixture = await legacySessionFixture(async () => ({
        text: 'Unexpected',
      }));
      try {
        const old = await journal(file);
        const text =
          kind === 'future-format' || kind === 'unknown-required-event'
            ? mutate(old.text, kind)
            : old.text;
        const path = await install(fixture.root, old.sessionId, text);
        const { client } = await fixture.runtime();
        await expect(client.recover(old.sessionId)).rejects.toThrow();
        expect(fixture.requests).toHaveLength(0);
        expect(await readFile(path, 'utf8')).toBe(text);
        expect(
          (await readdir(dirname(path))).filter((name) =>
            /^session\.v[34]\.jsonl$/.test(name),
          ),
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
    30_000,
  );
});
