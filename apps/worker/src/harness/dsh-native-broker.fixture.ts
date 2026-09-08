/** Real pinned DSH child + real JSON-RPC + synthetic loopback provider.
 * Transport contract only; this is not real-model/business acceptance. */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import type { HarnessExecutionInput } from './adapter.js';
import { DshProtocolClient } from './dsh-protocol-client.js';
import { DSH_DISTRIBUTION_CURRENT_VERSION } from './dsh-distribution.js';
import { dshInboundToolHandler } from './dsh/tool-bridge.js';

export async function nativeBrokerRoundtrip(input: {
  canonicalName: string;
  wireName: string;
  args: Record<string, unknown>;
  invalidArgs: Record<string, unknown>;
}) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-native-broker-'));
  const requests: Record<string, unknown>[] = [];
  const errors: unknown[] = [];
  const received: unknown[] = [];
  const sentinel = `synthetic-broker-${randomUUID()}`;
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const index = requests.length;
      if (index > 4) throw Error('synthetic provider call budget exceeded');
      const callsTool = index === 1 || index === 3;
      const common = {
        id: `synthetic-${index}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'native-contract',
      };
      res.setHeader('content-type', 'text/event-stream');
      for (const data of [
        {
          ...common,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                ...(callsTool
                  ? {
                      tool_calls: [
                        {
                          index: 0,
                          id: `call_${index}`,
                          type: 'function',
                          function: {
                            name: input.wireName,
                            arguments: JSON.stringify(
                              index === 1 ? input.args : input.invalidArgs,
                            ),
                          },
                        },
                      ],
                    }
                  : { content: 'Synthetic transport complete.' }),
              },
              finish_reason: null,
            },
          ],
        },
        {
          ...common,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: callsTool ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ])
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.end('data: [DONE]\n\n');
    })().catch((error: unknown) => {
      errors.push(error);
      res.statusCode = 500;
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
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
        '../../dsh/allrice-restricted.cordis.yml',
      ),
      DSH_DISTRIBUTION_VERSION: DSH_DISTRIBUTION_CURRENT_VERSION,
      DSH_SESSION_ROOT: join(root, 'sessions'),
      DSH_HOME: root,
      DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
      DSH_CWD: root,
      DSH_MODEL: 'native-contract',
      DSH_CODEX_MODEL: 'gpt-5.6-luna',
      DSH_OPENAI_COMPATIBLE_MODEL: 'native-contract',
      DSH_SYSTEM_PROMPT: 'Synthetic protocol test; only the selected tool.',
      OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
      OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${port}/v1`,
    },
  });
  const session = `native-${randomUUID()}`;
  let completed = 0;
  client.subscribe((notice) => {
    const event = notice.params.event as { type?: string } | undefined;
    if (notice.method === 'session.event' && event?.type === 'turn/end')
      completed++;
  });
  client.setRequestHandler(
    dshInboundToolHandler({
      tools: [
        {
          name: input.canonicalName,
          description: 'synthetic',
          inputSchema: { type: 'object' },
        },
      ],
      onToolCall: async (call) => {
        received.push(call);
        expect(call.name).toBe(input.canonicalName);
        expect(call.arguments).toEqual(input.args);
        return { modelContent: sentinel, summary: 'synthetic only' };
      },
    } satisfies Pick<HarnessExecutionInput, 'tools' | 'onToolCall'>),
  );
  try {
    await client.initialize({
      cwd: root,
      provider: 'openai-compatible',
      model: 'native-contract',
      nativeTools: [input.canonicalName],
      expectedVersion: DSH_DISTRIBUTION_CURRENT_VERSION,
    });
    await client.prompt(session, 'Invoke the selected native tool.');
    await expect.poll(() => requests.length, { timeout: 15000 }).toBe(2);
    await expect.poll(() => completed, { timeout: 15000 }).toBe(1);
    const tools = requests[0]!.tools as { function?: { name?: string } }[];
    expect(tools.some((tool) => tool.function?.name === input.wireName)).toBe(
      true,
    );
    expect(received).toHaveLength(1);
    expect(JSON.stringify(requests[1])).toContain(sentinel);
    await client.prompt(session, 'Reject invalid arguments before the Broker.');
    await expect.poll(() => requests.length, { timeout: 15000 }).toBe(4);
    await expect.poll(() => completed, { timeout: 15000 }).toBe(2);
    expect(received).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
    await rm(root, { recursive: true, force: true });
  }
}
