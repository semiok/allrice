import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeLocalMcpPayloadSchema,
  RuntimeLocalMcpResultSchema,
} from '@allrice/contracts';
import { fixturePayload, fixtureTool } from '../test/local-mcp.js';
import {
  localMcpWireProgram,
  normalizeLocalMcpTools,
  parseLocalMcpResult,
} from './local-mcp-protocol.js';
import { validateLocalMcpTools } from './local-mcp-runner.js';

interface Peer {
  request(method: string, params: unknown): Promise<unknown>;
  initialized(): Promise<void>;
  close(): void;
}
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
  vi.useRealTimers();
});
function wire(credential: string | null = null) {
  const child = { stdin: new PassThrough(), stdout: new PassThrough() };
  const failure = vi.fn();
  // Exact trusted wire program; controlled streams replace only its stdio port.
  const make = new Function(
    `${localMcpWireProgram}; return makePeer;`,
  ) as () => (child: unknown, failure: unknown, credential: unknown) => Peer;
  const peer = make()(child, failure, credential),
    requests: Record<string, unknown>[] = [];
  child.stdin.on('data', (chunk) => requests.push(JSON.parse(String(chunk))));
  closes.push(() => {
    peer.close();
    child.stdin.destroy();
    child.stdout.destroy();
  });
  const output = (message: unknown) =>
    child.stdout.write(JSON.stringify(message) + '\n');
  return { child, peer, failure, requests, output };
}

describe('P17 bounded contracts and trusted stdio framing', () => {
  it('keeps discover separate from a frozen invocation and denies unsupported host fields', () => {
    const value = fixturePayload();
    expect(RuntimeLocalMcpPayloadSchema.safeParse(value).success).toBe(true);
    expect(
      RuntimeLocalMcpPayloadSchema.safeParse({
        ...value,
        arguments: { ...value.arguments, executable: '/bin/sh' },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalMcpPayloadSchema.safeParse({
        ...value,
        arguments: { ...value.arguments, network: 'host' },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalMcpPayloadSchema.safeParse({
        ...value,
        arguments: { ...value.arguments, path: '../' },
      }).success,
    ).toBe(false);
  });
  it('enforces manifest membership, non-overlap, and frozen scope/argument limits', () => {
    const value = fixturePayload(undefined, true);
    expect(
      RuntimeLocalMcpPayloadSchema.safeParse({
        ...value,
        arguments: {
          ...value.arguments,
          toolArguments: { text: 'x'.repeat(8192) },
        },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalMcpPayloadSchema.safeParse({
        ...value,
        arguments: { ...value.arguments, connectionRevision: 2 },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalMcpPayloadSchema.safeParse({
        ...value,
        arguments: {
          ...value.arguments,
          source: { ...value.arguments.source, entrypoint: 'other.mjs' },
        },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalMcpPayloadSchema.safeParse({
        ...value,
        arguments: {
          ...value.arguments,
          source: {
            ...value.arguments.source,
            files: [
              value.arguments.source.files[0],
              value.arguments.source.files[0],
            ],
          },
        },
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate tool names, oversize discovery and unsupported JSON schema keywords', () => {
    expect(() => normalizeLocalMcpTools([fixtureTool, fixtureTool])).toThrow();
    expect(() => normalizeLocalMcpTools(Array(33).fill(fixtureTool))).toThrow();
    expect(() =>
      validateLocalMcpTools([
        {
          ...fixtureTool,
          inputSchema: { type: 'object', $ref: 'https://example.test/schema' },
        },
      ]),
    ).toThrow();
    expect(() =>
      validateLocalMcpTools([
        {
          ...fixtureTool,
          inputSchema: {
            type: 'object',
            properties: { a: { type: 'string', pattern: '(a+)+$' } },
          },
        },
      ]),
    ).toThrow();
    expect(() => validateLocalMcpTools([fixtureTool])).not.toThrow();
  });
  it('retains isError and rejects unbounded/non-text tool outputs', () => {
    expect(parseLocalMcpResult({ content: [], isError: true }).isError).toBe(
      true,
    );
    expect(() =>
      parseLocalMcpResult({ content: [{ type: 'image', data: 'x' }] }),
    ).toThrow();
    expect(() =>
      parseLocalMcpResult({
        content: [{ type: 'text', text: 'x'.repeat(65536) }],
      }),
    ).toThrow();
    expect(
      RuntimeLocalMcpResultSchema.safeParse({ resultKnown: true }).success,
    ).toBe(false);
  });
  it('handles fragmented protocol lines and distinct initialize/list/call request IDs', async () => {
    const { child, peer, requests } = wire();
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const pending = peer.request(method, {});
      const id = requests.at(-1)!.id;
      const line =
        JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }) + '\n';
      child.stdout.write(line.slice(0, 4));
      child.stdout.write(line.slice(4));
      expect(await pending).toEqual({ ok: true });
    }
    expect(requests.map((r) => r.id)).toEqual([1, 2, 3]);
  });
  it('denies server-requested roots/sampling without executing a capability', async () => {
    const { peer, output, requests } = wire();
    const result = peer.request('initialize', {});
    output({
      jsonrpc: '2.0',
      id: 'server-1',
      method: 'sampling/createMessage',
      params: {},
    });
    expect(requests[1]).toMatchObject({
      id: 'server-1',
      error: { code: -32601 },
    });
    output({ jsonrpc: '2.0', id: 1, result: {} });
    await result;
  });
  it.each([
    'wrong-id',
    'double-result',
    'invalid-json',
    'invalid-utf8',
    'large-line',
    'changed-tools',
  ])('fails closed on %s', async (mode) => {
    const { child, peer, output, failure } = wire();
    const pending = peer.request('tools/list', {});
    const rejection = expect(pending).rejects.toThrow('protocol');
    if (mode === 'wrong-id') output({ jsonrpc: '2.0', id: 9, result: {} });
    if (mode === 'double-result')
      output({ jsonrpc: '2.0', id: 1, result: {}, error: {} });
    if (mode === 'invalid-json') child.stdout.write('{invalid}\n');
    if (mode === 'invalid-utf8') child.stdout.write(Buffer.from([0xff, 10]));
    if (mode === 'large-line') child.stdout.write('x'.repeat(65537));
    if (mode === 'changed-tools')
      output({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    await rejection;
    expect(failure).toHaveBeenCalledTimes(1);
  });
  it.each(['quoted"token-value', 'back\\slash-token', 'plain-secret-token'])(
    'never forwards a configured token, including JSON escapes',
    async (secret) => {
      const { peer, output, failure } = wire(secret);
      const pending = peer.request('tools/call', {}),
        rejection = expect(pending).rejects.toThrow('protocol');
      output({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: secret }] },
      });
      await rejection;
      expect(JSON.stringify(failure.mock.calls)).not.toContain(secret);
    },
  );
  it('bounds a silent protocol peer instead of leaving a pending request', async () => {
    vi.useFakeTimers();
    const { peer, failure } = wire();
    const pending = peer.request('initialize', {}),
      rejection = expect(pending).rejects.toThrow('protocol');
    await vi.advanceTimersByTimeAsync(10001);
    await rejection;
    expect(failure).toHaveBeenCalledWith('timeout');
  });
});
