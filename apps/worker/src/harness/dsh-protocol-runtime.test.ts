import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DSH_DISTRIBUTION_CURRENT_VERSION } from './dsh-distribution.js';
import { DshProtocolClient } from './dsh-protocol-client.js';

const roots: string[] = [];
const clients: DshProtocolClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('AllRice DSH protocol runtime', () => {
  it('reports the approved version and exposes native lifecycle methods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allrice-dsh-protocol-'));
    roots.push(root);
    const client = new DshProtocolClient({
      command: process.execPath,
      args: [
        resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
      ],
      cwd: root,
      requestTimeoutMs: 15_000,
      environment: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        DSH_CORDIS_CONFIG: resolve(
          import.meta.dirname,
          '../../dsh/allrice-restricted.cordis.yml',
        ),
        DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
        DSH_SESSION_ROOT: resolve(root, 'sessions'),
        DSH_HOME: root,
        DSH_CREDENTIALS_PATH: resolve(root, '.credentials.yaml'),
        DSH_CWD: root,
        DSH_MODEL: 'contract-model',
        DSH_CODEX_MODEL: 'gpt-5.6-luna',
        DSH_OPENAI_COMPATIBLE_MODEL: 'contract-model',
        DSH_SYSTEM_PROMPT: 'AllRice protocol contract test.',
        DEEPSEEK_API_KEY: 'contract-test',
        OPENAI_COMPATIBLE_API_KEY: 'contract-test',
        OPENAI_COMPATIBLE_BASE_URL: 'https://example.invalid/v1',
      },
    });
    clients.push(client);
    await expect(
      client.initialize({
        cwd: root,
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        maxTokens: 1_024,
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
      }),
    ).resolves.toEqual({
      name: 'deepseek-harness-sdk-runtime',
      version: DSH_DISTRIBUTION_CURRENT_VERSION,
    });
    await expect(client.interrupt('dsh-not-live')).resolves.toMatchObject({
      interrupted: false,
    });
    await expect(client.compact('dsh-not-live')).resolves.toMatchObject({
      compacted: false,
    });
    await expect(client.closeSession('dsh-not-live')).resolves.toMatchObject({
      closed: false,
    });
    await expect(client.providerStatus()).resolves.toMatchObject({
      provider: 'openai-codex',
      configured: false,
      writable: true,
    });
  }, 20_000);
});
