import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('actual DSH provider reasoning configuration (offline)', () => {
  it.each(['low', 'medium', 'high'])(
    'sends Gemini %s as a distinct thinkingLevel',
    async (effort) => {
      const root = await mkdtemp(join(tmpdir(), 'allrice-reasoning-wire-'));
      try {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [resolve(import.meta.dirname, 'fixtures/dsh-reasoning-probe.mjs')],
          {
            cwd: root,
            timeout: 20_000,
            env: {
              PATH: process.env.PATH,
              DSH_HOME: root,
              DSH_RUNTIME_HOME: root,
              DSH_CWD: root,
              DSH_CREDENTIALS_PATH: join(root, '.credentials.yaml'),
              DSH_SESSION_ROOT: join(root, 'sessions'),
              DSH_CORDIS_CONFIG: resolve(
                import.meta.dirname,
                '../../dsh/allrice-restricted.cordis.yml',
              ),
              DSH_GEMINI_MODEL: 'gemini-3.8-flash',
              DSH_GEMINI_REASONING_EFFORT: effort,
              DSH_CODEX_MODEL: 'gpt-5.6-luna',
              DSH_CODEX_REASONING_EFFORT: 'xhigh',
              GEMINI_API_KEY: 'synthetic-offline-key',
              HTTP_PROXY: 'http://127.0.0.1:1',
              HTTPS_PROXY: 'http://127.0.0.1:1',
            },
          },
        );
        const line = stdout
          .split('\n')
          .find((line) => line.startsWith('PROBE_RESULT='));
        expect(line).toBeDefined();
        const result = JSON.parse(line!.slice('PROBE_RESULT='.length));
        expect(result.gemini.defaultEffort).toBe(effort);
        expect(
          result.gemini.efforts.map((item: { id: string }) => item.id),
        ).toEqual(['low', 'medium', 'high']);
        expect(result.codex.defaultEffort).toBe('xhigh');
        expect(result.thinking, JSON.stringify(result)).toBeDefined();
        expect(result.thinking.thinkingLevel).toBe(effort.toUpperCase());
        expect(result.thinking.thinkingBudget).toBeUndefined();
        expect(
          result.chunks.filter(
            (chunk: { type: string; reason?: { kind: string } }) =>
              chunk.type === 'finish' && chunk.reason?.kind === 'error',
          ),
        ).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
