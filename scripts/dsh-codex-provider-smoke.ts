import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../apps/worker/src/harness/dsh-distribution.js';
import { DshProtocolClient } from '../apps/worker/src/harness/dsh-protocol-client.js';

const root = await mkdtemp(join(tmpdir(), 'allrice-dsh-codex-smoke-'));
const platformHome = resolve(
  process.env.ALLRICE_DSH_PLATFORM_HOME ?? '.local/dsh-platform',
);

const sessionId = `dsh-${randomUUID()}`;
const client = new DshProtocolClient({
  command: process.execPath,
  args: [resolve('apps/worker/dsh/allrice-jsonrpc-runtime.mjs')],
  cwd: root,
  requestTimeoutMs: 180_000,
  environment: {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    DSH_CORDIS_CONFIG: resolve('apps/worker/dsh/allrice-restricted.cordis.yml'),
    DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
    DSH_HOME: platformHome,
    DSH_CREDENTIALS_PATH: resolve(platformHome, '.credentials.yaml'),
    DSH_SESSION_ROOT: resolve(root, 'sessions'),
    DSH_CWD: root,
    DSH_MODEL: 'gpt-5.6-luna',
    DSH_REASONING_EFFORT: 'max',
    DSH_MAX_OUTPUT_TOKENS: '256',
    DSH_SYSTEM_PROMPT:
      'You are an AllRice acceptance probe. Follow the exact output request.',
  },
});

try {
  await client.initialize({
    cwd: root,
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    maxTokens: 256,
    expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
  });
  const completed = new Promise<{ text: string; provider: string }>(
    (resolveCompleted, reject) => {
      const timer = setTimeout(
        () => reject(new Error('DSH Codex Provider smoke timed out')),
        170_000,
      );
      const unsubscribe = client.subscribe((notification) => {
        if (notification.method !== 'session.event') return;
        const event = notification.params.event as
          { type?: string; data?: Record<string, unknown> } | undefined;
        if (event?.type !== 'assistant/message') return;
        const message = event.data?.message as
          | {
              content?: Array<{ type?: string; text?: string }>;
              source?: { provider?: string };
            }
          | undefined;
        const text =
          message?.content
            ?.filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('') ?? '';
        clearTimeout(timer);
        unsubscribe();
        resolveCompleted({
          text,
          provider: message?.source?.provider ?? 'unknown',
        });
      });
    },
  );
  await client.prompt(sessionId, 'Reply with exactly: DSH_CODEX_OK');
  const result = await completed;
  if (!result.text.includes('DSH_CODEX_OK')) {
    throw new Error('DSH Codex Provider returned an unexpected response');
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'ok', harness: 'dsh', provider: result.provider, model: 'gpt-5.6-luna' })}\n`,
  );
} finally {
  await client.close();
  await rm(root, { recursive: true, force: true });
}
