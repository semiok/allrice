/** Guard/cleanup regression only: no model, credential, or positive UI claim. */
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantFixtureDatabase } from '../../../packages/database/src/assistant-runtime.fixture.ts';
import { verifyCodexWorkerSessionsInChrome } from './p28-codex-session-ui.ts';

type Input = Parameters<typeof verifyCodexWorkerSessionsInChrome>[0];
const schema = `p25_${'a'.repeat(32)}`;
function input(
  databaseUrl = `postgres://a123@127.0.0.1:5432/allrice_b2?options=${encodeURIComponent(`-csearch_path=${schema},public`)}`,
): Input {
  return {
    fixture: {
      db: vi
        .fn()
        .mockRejectedValue(
          new Error('PRIVATE_DIAGNOSTIC_NOT_FOR_REPORT'),
        ) as unknown as Input['fixture']['db'],
      databaseUrl,
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      ownerId: randomUUID(),
    },
    assistant: { runId: randomUUID(), sessionId: randomUUID() },
    ordinary: { runId: randomUUID(), sessionId: randomUUID() },
    storageRoot: '/not-used',
    evidenceDirectory: '/not-used',
  };
}
describe('real Worker UI helper fail-closed guards', () => {
  it.each([
    'postgres://a123@192.0.2.1:5432/allrice_b2',
    'postgres://a123@127.0.0.1:5432/other_database',
    'postgres://a123:synthetic-secret@127.0.0.1:5432/allrice_b2',
    `postgres://a123@127.0.0.1:5432/allrice_b2?options=${encodeURIComponent('-csearch_path=public')}`,
    `postgres://a123@127.0.0.1:5432/allrice_b2?options=${encodeURIComponent(`-csearch_path=${schema},public`)}&sslmode=disable`,
  ])(
    'rejects invalid database target before using its pool (%#)',
    async (url) => {
      const options = input(url);
      const report = await verifyCodexWorkerSessionsInChrome(options);
      expect(options.fixture.db).not.toHaveBeenCalled();
      expect(report.passed).toBe(false);
      expect(report.failure).toEqual({
        code: 'P28_REAL_UI_FAILED',
        phase: 'fixture_scope',
      });
      expect(report.screenshots).toEqual([]);
      expect(Object.values(report.cleanup).every(Boolean)).toBe(true);
    },
  );
  it('rejects repeated sessions and malformed IDs before DB/browser access', async () => {
    for (const malformed of [false, true]) {
      const options = input();
      if (malformed) options.assistant.runId = 'not-a-run';
      else options.ordinary.sessionId = options.assistant.sessionId;
      expect((await verifyCodexWorkerSessionsInChrome(options)).passed).toBe(
        false,
      );
      expect(options.fixture.db).not.toHaveBeenCalled();
    }
  });
  it('returns only a fixed diagnostic on private database errors', async () => {
    const report = await verifyCodexWorkerSessionsInChrome(input());
    expect(report.passed).toBe(false);
    expect(report.failure).toEqual({
      code: 'P28_REAL_UI_FAILED',
      phase: 'fixture_scope',
    });
    expect(JSON.stringify(report)).not.toContain(
      'PRIVATE_DIAGNOSTIC_NOT_FOR_REPORT',
    );
  });
});

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration(
  'real isolated PG rejects absent Worker completions before Chrome',
  () => {
    it('saves failure evidence, keeps the caller pool/storage open, never overwrites evidence', async () => {
      expect(process.env.DATABASE_URL).toBeUndefined();
      expect(process.env.ALLRICE_TEST_DATABASE_URL).toBe(
        'postgres://a123@127.0.0.1:5432/allrice_b2',
      );
      const fixture = await createAssistantFixtureDatabase();
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'allrice-p27-codex-ui-guard-')),
      );
      try {
        const [{ schema: actualSchema }] =
          await fixture.db`select current_schema() as schema`;
        const options = input(
          `postgres://a123@127.0.0.1:5432/allrice_b2?options=${encodeURIComponent(`-csearch_path=${actualSchema},public`)}`,
        );
        options.fixture.db = fixture.db;
        options.storageRoot = join(directory, 'storage');
        options.evidenceDirectory = join(directory, 'evidence');
        await mkdir(options.storageRoot, { mode: 0o700 });
        await mkdir(options.evidenceDirectory, { mode: 0o700 });
        const report = await verifyCodexWorkerSessionsInChrome(options);
        expect(report.passed).toBe(false);
        expect(report.failure).toEqual({
          code: 'P28_REAL_UI_FAILED',
          phase: 'completed_history',
        });
        expect(Object.values(report.cleanup).every(Boolean)).toBe(true);
        expect(report.screenshots).toEqual([]);
        expect(await fixture.db`select 1 as still_open`).toMatchObject([
          { still_open: 1 },
        ]);
        expect(await realpath(options.storageRoot)).toBe(options.storageRoot);
        const saved = await readFile(report.evidencePath!, 'utf8');
        expect(JSON.parse(saved)).toEqual(report);
        const duplicate = await verifyCodexWorkerSessionsInChrome(options);
        expect(duplicate.passed).toBe(false);
        expect(duplicate.failure?.phase).toBe('evidence_directory');
        expect(await readFile(report.evidencePath!, 'utf8')).toBe(saved);
      } finally {
        const proof = await fixture.close();
        expect(proof).toMatchObject({
          schemaRemoved: true,
          storageRemoved: true,
          databaseClosed: true,
          adminClosed: true,
        });
        await rm(directory, { recursive: true, force: true });
      }
    }, 30000);
  },
);
