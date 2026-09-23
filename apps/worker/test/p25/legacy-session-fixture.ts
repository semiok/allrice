import { join, resolve } from 'node:path';

import { DSH_DISTRIBUTION_CURRENT_VERSION } from '../../src/harness/dsh-distribution.js';
import {
  DshProtocolClient,
  type DshNotification,
} from '../../src/harness/dsh-protocol-client.js';
import { p24Fixture } from '../p24/fixture.js';

/** Production stdio adapter, disposable storage, synthetic loopback model only. */
export async function legacySessionFixture(
  model: Parameters<typeof p24Fixture>[0],
) {
  const fixture = await p24Fixture(model);
  const clients: DshProtocolClient[] = [];
  return {
    ...fixture,
    async runtime(nativeTools: string[] = []) {
      const client = new DshProtocolClient({
        command: process.execPath,
        args: [
          resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
        ],
        cwd: fixture.root,
        requestTimeoutMs: 15_000,
        environment: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          DSH_CORDIS_CONFIG: resolve(
            import.meta.dirname,
            '../../dsh/allrice-restricted.cordis.yml',
          ),
          DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
          DSH_SESSION_ROOT: join(fixture.root, 'sessions'),
          DSH_HOME: fixture.root,
          DSH_CWD: fixture.root,
          DSH_CREDENTIALS_PATH: join(fixture.root, 'credentials.yaml'),
          DSH_MODEL: 'legacy-replay',
          DSH_OPENAI_COMPATIBLE_MODEL: 'legacy-replay',
          OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
          OPENAI_COMPATIBLE_BASE_URL: fixture.baseUrl,
        },
      });
      clients.push(client);
      const notices: DshNotification[] = [];
      client.subscribe((notice) => notices.push(notice));
      await client.initialize({
        cwd: fixture.root,
        provider: 'openai-compatible',
        model: 'legacy-replay',
        nativeTools,
        expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
        requireDurableQuestions: true,
      });
      return { client, notices };
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
      await fixture.close();
    },
  };
}

export async function waitForLegacyNotice(
  predicate: () => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Legacy fixture timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
