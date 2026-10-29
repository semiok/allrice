import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { DshProtocolClient } from '../../src/harness/dsh-protocol-client.ts';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
afterEach(() => vi.useRealTimers());

function fixture() {
  const child = new EventEmitter();
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const frames: { id: number; method: string; params?: unknown }[] = [];
  const stdin = new Writable({
    write(chunk, _, done) {
      frames.push(JSON.parse(String(chunk)));
      done();
    },
  });
  Object.assign(child, { pid: 31337, stdout, stderr, stdin, kill: vi.fn() });
  mocks.spawn.mockReturnValue(child);
  const client = new DshProtocolClient({
    command: 'fake-only',
    args: [],
    cwd: '/fake-only',
    environment: {},
    requestTimeoutMs: 5,
  });
  client.onFailure(() => {});
  const exit = () => {
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
  };
  return {
    client,
    frames,
    exit,
    reply: (value: object) =>
      stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: frames[0]!.id, ...value }) + '\n',
      ),
  };
}

it('T14 Worker session/wait outlives the RPC timeout and forwards the native result', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let settled = false;
  const wait = f.client.wait('root').then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).toBe(false);
  expect(f.frames).toEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/wait',
      params: { sessionId: 'root' },
    },
  ]);
  f.reply({ result: {} });
  await expect(wait).resolves.toEqual({});
  f.exit();
});

it('T14 Worker preserves native disposal cause without permitting replay', async () => {
  const f = fixture();
  const wait = expect(f.client.wait('root')).rejects.toMatchObject({
    code: 'DSH_WAIT_FAILED',
    retryable: false,
    cause: { message: 'session agent was disposed outside the server' },
  });
  f.reply({
    error: {
      code: -32603,
      message: 'session agent was disposed outside the server',
    },
  });
  await wait;
  f.exit();
});

it('T14 Worker rejects a pending wait when the process dies', async () => {
  const f = fixture();
  const wait = expect(f.client.wait('root')).rejects.toThrow();
  f.exit();
  await wait;
});
