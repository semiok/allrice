import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export interface ModelRequest {
  messages: { role: string; content?: unknown; tool_calls?: unknown }[];
  tools?: { function: { name: string } }[];
}
export interface ModelReply {
  text?: string;
  tool?: { marker: string };
  nativeTool?: { name: string; arguments: Record<string, unknown> };
  usage?: Record<string, unknown> | null;
}
export interface NativeSnapshot {
  live: boolean;
  status?: string;
  header?: { parentSession?: string; delegationDepth?: number };
  events: { type: string; data: Record<string, unknown> }[];
  observations: { event: string; id: string; stopReason?: string }[];
  interactiveRequests: number;
}
export type ProposalHandler = (
  p: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
export interface P24Client {
  call<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  snapshot(id: string): Promise<NativeSnapshot>;
  crash(): Promise<void>;
  close(): Promise<void>;
}

export async function p24Fixture(
  model: (
    request: ModelRequest,
    index: number,
  ) => Promise<ModelReply> = async () => ({ text: 'Synthetic completed.' }),
  proposal: ProposalHandler = async () => ({ status: 'not_configured' }),
  writeBatchMaxDelayMs = 200,
  extension?: {
    p25: true;
    callback: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
  },
) {
  const root = await mkdtemp(join(tmpdir(), 'allrice-p24-'));
  const requests: ModelRequest[] = [];
  const abortedRequests: ModelRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2_000_000) throw new Error('synthetic request too large');
        chunks.push(Buffer.from(chunk));
      }
      const input = JSON.parse(
        Buffer.concat(chunks).toString(),
      ) as ModelRequest;
      requests.push(input);
      res.on('close', () => {
        if (!res.writableFinished) abortedRequests.push(input);
      });
      const result = await model(input, requests.length);
      if (res.destroyed) return;
      res.setHeader('content-type', 'text/event-stream');
      const common = {
        id: `p24-${requests.length}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: 'p24-synthetic',
      };
      const delta =
        result.tool || result.nativeTool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call-${requests.length}`,
                  type: 'function',
                  function: {
                    name: result.nativeTool?.name ?? 'p24_proposal',
                    arguments: JSON.stringify(
                      result.nativeTool?.arguments ?? result.tool,
                    ),
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content: result.text ?? 'Synthetic completed.',
            };
      for (const data of [
        { ...common, choices: [{ index: 0, delta, finish_reason: null }] },
        {
          ...common,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason:
                result.tool || result.nativeTool ? 'tool_calls' : 'stop',
            },
          ],
          ...(result.usage === null
            ? {}
            : {
                usage: result.usage ?? {
                  prompt_tokens: 20,
                  completion_tokens: 5,
                  total_tokens: 25,
                },
              }),
        },
      ])
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.end('data: [DONE]\n\n');
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const environment = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    ALLRICE_P24_TEST: 'synthetic-only',
    DSH_CWD: root,
    DSH_HOME: root,
    DSH_SESSION_ROOT: join(root, 'sessions'),
    DSH_CREDENTIALS_PATH: join(root, 'credentials.yaml'),
    P24_WRITE_BATCH_MS: String(writeBatchMaxDelayMs),
    OPENAI_COMPATIBLE_API_KEY: 'synthetic-only',
    OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
  };
  const clients: P24Client[] = [];
  function launch(): P24Client {
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dirname, 'runtime.mjs')],
      {
        cwd: root,
        env: {
          ...environment,
          ...(extension ? { ALLRICE_P25_TEST: 'synthetic-only' } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const pending = new Map<
      number,
      {
        resolve(v: unknown): void;
        reject(e: Error): void;
        timer: NodeJS.Timeout;
      }
    >();
    let sequence = 0;
    let stderr = '';
    let exited = false;
    child.stderr.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-16_000);
    });
    const closed = new Promise<void>((r) =>
      child.once('close', () => {
        exited = true;
        for (const value of pending.values()) {
          clearTimeout(value.timer);
          value.reject(new Error(`P24 runtime closed: ${stderr}`));
        }
        pending.clear();
        r();
      }),
    );
    const write = (data: unknown) => {
      if (!exited && child.stdin.writable)
        child.stdin.write(JSON.stringify(data) + '\n');
    };
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.method && message.id !== undefined) {
        const response =
          extension && message.method.startsWith('p25/')
            ? extension.callback(message.method.slice(4), message.params ?? {})
            : message.method === 'p24/proposal'
              ? proposal(message.params ?? {})
              : Promise.reject(new Error('unsupported callback'));
        void response.then(
          (result) => write({ jsonrpc: '2.0', id: message.id, result }),
          (e: Error) =>
            write({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32000, message: e.message },
            }),
        );
        return;
      }
      if (message.id === undefined) return;
      const value = pending.get(message.id);
      if (!value) return;
      pending.delete(message.id);
      clearTimeout(value.timer);
      if (message.error) value.reject(new Error(message.error.message));
      else value.resolve(message.result);
    });
    function call<T = Record<string, unknown>>(
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<T> {
      if (exited) return Promise.reject(new Error('P24 runtime exited'));
      return new Promise<T>((resolvePromise, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`P24 ${method} timeout: ${stderr}`));
        }, 30_000);
        pending.set(id, {
          resolve: (value) => resolvePromise(value as T),
          reject,
          timer,
        });
        write({ jsonrpc: '2.0', id, method, params });
      });
    }
    const client = {
      call,
      snapshot: (id: string) => call<NativeSnapshot>('snapshot', { id }),
      async crash() {
        child.kill('SIGKILL');
        await closed;
        lines.close();
      },
      async close() {
        if (!exited) {
          try {
            await call('shutdown');
          } finally {
            const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
            await closed;
            clearTimeout(timer);
          }
        }
        lines.close();
      },
    };
    clients.push(client);
    return client;
  }
  return {
    root,
    baseUrl: environment.OPENAI_COMPATIBLE_BASE_URL,
    requests,
    abortedRequests,
    launch,
    async logs() {
      const paths = await readdir(join(root, 'sessions'), { recursive: true });
      return (
        await Promise.all(
          paths
            .filter((p) => p.endsWith('.jsonl'))
            .map((p) => readFile(join(root, 'sessions', p), 'utf8')),
        )
      ).join('\n');
    },
    async close() {
      for (const client of clients) await client.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
