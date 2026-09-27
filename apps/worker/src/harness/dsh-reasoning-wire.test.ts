import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('actual DSH provider reasoning configuration (offline)', () => {
  it.each(['low', 'medium', 'high'])(
    'keeps Codex %s reasoning and rejects retired Gemini',
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
              DSH_CODEX_REASONING_EFFORT: effort,
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
        expect(result.codex.defaultEffort).toBe(effort);
        expect(result.geminiRetired).toBe(true);
        expect(result.networkCalls).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
