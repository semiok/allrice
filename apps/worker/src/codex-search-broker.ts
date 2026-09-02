import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DSH_DISTRIBUTION_CURRENT_VERSION } from './harness/dsh-distribution.js';
import { dshEgressEnvironment } from './harness/dsh-egress-environment.js';
import { DshProtocolClient } from './harness/dsh-protocol-client.js';

function platformHome() {
  return resolve(
    process.env.ALLRICE_DSH_PLATFORM_HOME ?? '.local/dsh-platform',
  );
}

function searchEnvironment(root: string) {
  const home = platformHome();
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...dshEgressEnvironment(),
    DSH_CORDIS_CONFIG: resolve(
      process.env.ALLRICE_DSH_CORDIS_CONFIG ??
        resolve(import.meta.dirname, '../dsh/allrice-restricted.cordis.yml'),
    ),
    DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
    DSH_HOME: home,
    DSH_CREDENTIALS_PATH: resolve(home, '.credentials.yaml'),
    DSH_SESSION_ROOT: resolve(root, 'sessions'),
    DSH_CWD: root,
    DSH_MODEL:
      process.env.ALLRICE_DSH_CODEX_MODEL ??
      process.env.ALLRICE_CODEX_MODEL ??
      'gpt-5.6-luna',
    DSH_CODEX_MODEL:
      process.env.ALLRICE_DSH_CODEX_MODEL ??
      process.env.ALLRICE_CODEX_MODEL ??
      'gpt-5.6-luna',
    DSH_OPENAI_COMPATIBLE_MODEL: 'allrice-unused',
    OPENAI_COMPATIBLE_BASE_URL: 'https://unused.invalid/v1',
    DSH_REASONING_EFFORT: 'max',
    DSH_MAX_OUTPUT_TOKENS: '256',
    DSH_SYSTEM_PROMPT: 'AllRice Codex hosted search provider.',
  };
}

export async function searchCodexHostedWeb(query: string, maxResults = 5) {
  const executionRoot = resolve(
    process.env.ALLRICE_EXECUTION_ROOT ?? '.local/executions',
    'codex-hosted-search',
  );
  const home = platformHome();
  await Promise.all([
    mkdir(executionRoot, { recursive: true, mode: 0o700 }),
    mkdir(home, { recursive: true, mode: 0o700 }),
  ]);
  const client = new DshProtocolClient({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '../dsh/allrice-jsonrpc-runtime.mjs')],
    cwd: executionRoot,
    environment: searchEnvironment(executionRoot),
    requestTimeoutMs: 70_000,
  });
  try {
    await client.initialize({
      cwd: executionRoot,
      provider: 'openai-codex',
      model:
        process.env.ALLRICE_DSH_CODEX_MODEL ??
        process.env.ALLRICE_CODEX_MODEL ??
        'gpt-5.6-luna',
      maxTokens: 256,
      expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
    });
    return await client.searchCodexWeb(query, maxResults);
  } finally {
    await client.close();
  }
}
