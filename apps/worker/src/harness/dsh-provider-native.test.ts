import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { DshProtocolClient } from './dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from './dsh-distribution.js';

const clients: DshProtocolClient[] = [],
  roots: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function host(profile: string, baseURL = 'http://127.0.0.1:1') {
  const root = await mkdtemp(join(tmpdir(), 'allrice-native-provider-'));
  roots.push(root);
  await mkdir(join(root, 'sessions'));
  const client = new DshProtocolClient({
    command: process.execPath,
    args: [
      resolve(import.meta.dirname, '../../dsh/allrice-jsonrpc-runtime.mjs'),
    ],
    cwd: root,
    requestTimeoutMs: 15000,
    environment: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      DSH_CORDIS_CONFIG: resolve(
        import.meta.dirname,
        `../../dsh/allrice-${profile}.cordis.yml`,
      ),
      DSH_HOME: root,
      DSH_RUNTIME_HOME: root,
      DSH_CWD: root,
      DSH_SESSION_ROOT: join(root, 'sessions'),
      DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
      NARB_NATIVE_CACHE_DIR: join(root, 'native-cache'),
      DEEPSEEK_API_KEY: 'synthetic-provider-test-only',
      DEEPSEEK_BASE_URL: baseURL,
      DSH_OPENAI_COMPATIBLE_MODEL: 'synthetic-provider',
      DSH_CODEX_MODEL: 'gpt-6.1-sol',
      DSH_REASONING_EFFORT: 'off',
      DSH_MAX_OUTPUT_TOKENS: '1000',
    },
  });
  clients.push(client);
  let stderr = '';
  // Test-only observation of an isolated child carrying synthetic credentials.
  // Production deliberately drains stderr without exposing it to users.
  const child = (
    client as unknown as {
      child: ChildProcessWithoutNullStreams;
    }
  ).child;
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });
  return { client, root, stderr: () => stderr };
}
const routes = [
  ['openai-compatible', 'synthetic-provider'],
  ['openai-codex', 'gpt-6.1-sol'],
  ['deepseek-official', 'deepseek-v4-flash'],
] as const;
it.each(
  ['restricted', 'technical'].flatMap((profile) =>
    routes.map(([provider, model]) => ({ profile, provider, model })),
  ),
)(
  'initializes the actual $profile composition for $provider without inactive provider plugins or paid calls',
  async ({ profile, provider, model }) => {
    const h = await host(profile);
    await h.client.initialize({
      cwd: h.root,
      provider,
      model,
      nativeTools: [],
      expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
    });
    expect(h.stderr()).not.toMatch(/did not activate|failed to import/);
  },
  30000,
);
it.each(['restricted', 'technical'])(
  'runs native DeepSeek Messages on %s with the frozen legacy model name and a local synthetic endpoint',
  async (profile) => {
    const requests: {
      path: string;
      apiKey: string | string[] | undefined;
      body: Record<string, unknown>;
    }[] = [];
    const server = createServer((req, res) => {
      void (async () => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        requests.push({
          path: req.url!,
          apiKey: req.headers['x-api-key'],
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frames = [
          {
            type: 'message_start',
            message: {
              id: 'synthetic-deepseek',
              type: 'message',
              role: 'assistant',
              model: 'deepseek-v4-flash',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 12, output_tokens: 0 },
            },
          },
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'DEEPSEEK_NATIVE_OK' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        ];
        for (const frame of frames)
          res.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
        res.end();
      })().catch(() => {
        res.statusCode = 500;
        res.end();
      });
    }).listen(0, '127.0.0.1');
    servers.push(server);
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('missing local listener');
    const h = await host(profile, `http://127.0.0.1:${address.port}`);
    await h.client.initialize({
      cwd: h.root,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      nativeTools: [],
      maxTokens: 1000,
      expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
    });
    const id = 'dsh-' + randomUUID(),
      notices: unknown[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('LOCAL_DEEPSEEK_IDLE_DEADLINE')),
        15000,
      );
      h.client.subscribe((n) => {
        notices.push(n);
        if (
          n.method === 'session.status' &&
          n.params.sessionId === id &&
          n.params.status === 'idle'
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await h.client.prompt(id, 'Return the fixed synthetic response.');
    await done;
    expect(JSON.stringify(notices)).toContain('DEEPSEEK_NATIVE_OK');
    expect(h.stderr()).not.toMatch(/did not activate|failed to import/);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe('/v1/messages');
    expect(requests[0]!.apiKey).toBe('synthetic-provider-test-only');
    expect(requests[0]!.body).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      max_tokens: 1000,
    });
  },
  30000,
);
