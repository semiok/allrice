import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, rename, writeFile, lstat } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type {
  ProjectPreviewClientFrame,
  ProjectServiceTarget,
} from '@allrice/contracts';
import type { getDatabase } from '@allrice/database';
import type * as DatabaseModule from '@allrice/database';
import type * as ContractsModule from '@allrice/contracts';
import type { CloudRunnerBackend } from './backend.js';
const state = vi.hoisted(() => ({
  authorize: vi.fn(),
  inspect: vi.fn(),
  assertContainer: vi.fn(),
  input: vi.fn(),
  received: vi.fn(),
  relayClose: vi.fn(),
  send: undefined as
    undefined | ((frame: ProjectPreviewClientFrame) => Promise<boolean>),
}));
vi.mock('@allrice/database', async (importOriginal) => ({
  ...(await importOriginal<typeof DatabaseModule>()),
  projectServicePreviewTarget: state.authorize,
}));
vi.mock('@allrice/contracts', async (importOriginal) => ({
  ...(await importOriginal<typeof ContractsModule>()),
  CloudProjectCommandSchema: { parse: () => ({ arguments: {} }) },
}));
vi.mock('./project.js', () => ({
  assertCloudProjectContainer: state.assertContainer,
}));
// The private IPC lifetime is the subject; shared Docker relay ownership is
// separately unverified. Positive native behavior uses the real integration suite.
vi.mock('@allrice/project-runtime', () => ({
  ContainerProjectPreviewRelay: class {
    receive(
      frame: unknown,
      send: (frame: ProjectPreviewClientFrame) => Promise<boolean>,
    ) {
      state.received(frame);
      state.send = send;
    }
    close() {
      state.relayClose();
    }
  },
}));
const { startCloudProjectPreviewTransport } =
  await import('./project-preview-transport.js');
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  gates.push(resolve);
  return { promise, resolve };
};
const gates: (() => void)[] = [];
let root: string, path: string;
let transport:
  Awaited<ReturnType<typeof startCloudProjectPreviewTransport>> | undefined;
const clients: (WebSocket | Socket)[] = [];
const target = (): ProjectServiceTarget => ({
  serviceId: randomUUID(),
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
  ownerId: randomUUID(),
  backend: 'cloud',
  deviceId: null,
  operationId: randomUUID(),
  attemptId: randomUUID(),
  containerId: 'a'.repeat(64),
  imageDigest: 'sha256:' + 'b'.repeat(64),
  port: 5173,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  hardDeadlineAt: new Date(Date.now() + 120000).toISOString(),
});
let value: ProjectServiceTarget;
let frameId: string;
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await delay(10);
  }
  throw Error('IPC fixture boundary not observed');
}
async function start(onError?: (error: unknown) => void) {
  transport = await startCloudProjectPreviewTransport(path, {
    database: state.input as unknown as ReturnType<typeof getDatabase>,
    backend: { inspect: state.inspect } as unknown as CloudRunnerBackend,
    onError,
  });
  return transport;
}
async function client() {
  const ws = new WebSocket('ws://localhost/internal/project-preview', {
    createConnection: () => connect(path),
  });
  clients.push(ws);
  ws.on('error', () => undefined);
  await once(ws, 'open');
  return ws;
}
function open(ws: WebSocket) {
  ws.send(
    JSON.stringify({
      version: 1,
      id: frameId,
      type: 'preview.open',
      target: value,
      request: {
        method: 'GET',
        path: '/',
        host: 'localhost',
        headers: {},
        websocket: false,
      },
    }),
  );
}
async function retained(promise: Promise<void>) {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await delay(40);
  expect(done).toBe(false);
}
beforeEach(async () => {
  vi.clearAllMocks();
  gates.length = 0;
  state.send = undefined;
  root = await mkdtemp('/tmp/ar-c3a-');
  path = root + '/p.sock';
  value = target();
  frameId = randomUUID();
  state.authorize.mockImplementation(async () => value);
  state.input.mockResolvedValue([{ payload: {} }]);
  state.inspect.mockResolvedValue({
    Id: value.containerId,
    State: { Running: true },
    Config: {
      Labels: { 'xyz.bplabs.allrice.cloud.service-id': value.serviceId },
    },
  });
  state.assertContainer.mockResolvedValue(undefined);
  state.relayClose.mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const release of gates) release();
  for (const client of clients.splice(0)) {
    if (client instanceof WebSocket) client.terminate();
    else client.destroy();
  }
  await transport?.close().catch(() => undefined);
  transport = undefined;
  await rm(root, { recursive: true, force: true });
});
describe('Worker preview IPC owned lifetime over actual Unix sockets', () => {
  it('counts disconnected owners toward capacity until authorization truly drains', async () => {
    const wait = gate();
    state.authorize.mockImplementation(async () => {
      await wait.promise;
      return value;
    });
    await start();
    for (let n = 0; n < 64; n++) {
      const ws = await client();
      open(ws);
      await until(() => state.authorize.mock.calls.length === n + 1);
      const ended = once(ws, 'close');
      ws.terminate();
      await ended;
    }
    await delay(40);
    const rejected = new WebSocket('ws://localhost/internal/project-preview', {
      createConnection: () => connect(path),
    });
    rejected.on('error', () => undefined);
    clients.push(rejected);
    const status = await new Promise<number | undefined>((resolve) =>
      rejected.once('unexpected-response', (_request, response) => {
        response.resume();
        rejected.terminate();
        resolve(response.statusCode);
      }),
    );
    expect(status).toBe(403);
    expect(state.authorize).toHaveBeenCalledTimes(64);
    wait.resolve();
    await delay(40);
    const admitted = await client();
    open(admitted);
    await until(() => state.received.mock.calls.length === 1);
    expect(state.authorize).toHaveBeenCalledTimes(65);
  }, 15000);
  it('fences admission and joins incomplete HTTP connections with one close result', async () => {
    const t = await start();
    const raw = connect(path);
    clients.push(raw);
    raw.on('error', () => undefined);
    await once(raw, 'connect');
    raw.write('GET /internal/project-preview HTTP/1.1\r\n');
    // Closing an incomplete HTTP request may reset its peer on Linux.
    // Observe the actual close independently of the expected socket error.
    const end = new Promise<void>((resolve) =>
      raw.once('close', () => resolve()),
    );
    const closing = t.close();
    expect(t.close()).toBe(closing);
    await closing;
    await end;
    expect((await lstat(path)).isSocket()).toBe(true);
    const late = connect(path);
    late.on('error', () => undefined);
    clients.push(late);
    await new Promise<void>((resolve) => late.once('close', () => resolve()));
    expect(state.authorize).not.toHaveBeenCalled();
  });
  it('retains disconnected owners and skips input lookup after initial authority returns late', async () => {
    const wait = gate();
    state.authorize.mockImplementation(async () => {
      await wait.promise;
      return value;
    });
    const t = await start();
    const ws = await client();
    open(ws);
    await until(() => state.authorize.mock.calls.length === 1);
    const end = once(ws, 'close');
    ws.terminate();
    await end;
    const closing = t.close();
    await retained(closing);
    wait.resolve();
    await closing;
    expect(state.input).not.toHaveBeenCalled();
    expect(state.received).not.toHaveBeenCalled();
  });
  it('joins a late physical inspect but does not start container validation or relay', async () => {
    const wait = gate();
    state.inspect.mockImplementation(async () => {
      await wait.promise;
      return { Id: value.containerId, State: { Running: true } };
    });
    const t = await start();
    const ws = await client();
    open(ws);
    await until(() => state.inspect.mock.calls.length === 1);
    const closing = t.close();
    await retained(closing);
    wait.resolve();
    await closing;
    expect(state.assertContainer).not.toHaveBeenCalled();
    expect(state.received).not.toHaveBeenCalled();
  });
  it('joins timer reauthorization after the IPC client is already gone', async () => {
    const wait = gate();
    let calls = 0;
    state.authorize.mockImplementation(async () => {
      if (++calls === 2) await wait.promise;
      return value;
    });
    const t = await start();
    const ws = await client();
    open(ws);
    await until(() => state.received.mock.calls.length === 1);
    await until(() => calls === 2);
    ws.terminate();
    const closing = t.close();
    await retained(closing);
    wait.resolve();
    await closing;
    expect(state.input).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch queued frames after shutdown starts', async () => {
    const wait = gate();
    state.authorize.mockImplementation(async () => {
      await wait.promise;
      return value;
    });
    const t = await start();
    const ws = await client();
    open(ws);
    ws.send(JSON.stringify({ version: 1, id: frameId, type: 'preview.end' }));
    await until(() => state.authorize.mock.calls.length === 1);
    const closing = t.close();
    await retained(closing);
    wait.resolve();
    await closing;
    expect(state.authorize).toHaveBeenCalledTimes(1);
    expect(state.received).not.toHaveBeenCalled();
  });
  it('reentrant close and a throwing reporter cannot skip cleanup or deadlock the callback', async () => {
    state.authorize.mockRejectedValue(Error('revoked'));
    const t = await start(() => {
      void transport?.close();
      throw Error('reporter');
    });
    const ws = await client();
    const end = once(ws, 'close');
    open(ws);
    await end;
    await t.close();
    expect(state.input).not.toHaveBeenCalled();
    expect(state.relayClose).toHaveBeenCalledTimes(1);
  });
  it('keeps cleanup failures even after a disconnected owner leaves the routing set', async () => {
    state.relayClose.mockImplementation(() => {
      throw Error('unknown cleanup');
    });
    const t = await start();
    const ws = await client();
    const end = once(ws, 'close');
    ws.terminate();
    await end;
    await expect(t.close()).rejects.toThrow('unknown cleanup');
    await expect(t.close()).rejects.toThrow('unknown cleanup');
  });
  it('preserves a replacement socket-path inode during cleanup', async () => {
    const t = await start();
    const replacement = root + '/replacement';
    await writeFile(replacement, 'other owner');
    const before = await lstat(replacement);
    await rename(replacement, path);
    await t.close();
    expect((await lstat(path)).ino).toBe(before.ino);
  });
  it('joins an already-started send callback before completion and refuses further sends', async () => {
    const t = await start();
    const ws = await client();
    open(ws);
    await until(() => Boolean(state.send));
    // The real IPC send callback is held; payload still traverses an actual Unix socket.
    const prototype = WebSocket.prototype;
    const original = prototype.send;
    let release: (() => void) | undefined;
    const spy = vi.spyOn(prototype, 'send').mockImplementation(function (
      this: WebSocket,
      data,
      options,
      callback,
    ) {
      const done = typeof options === 'function' ? options : callback;
      return original.call(this, data, {}, (error?: Error) => {
        release = () => done?.(error);
      });
    });
    const response: ProjectPreviewClientFrame = {
      version: 1,
      type: 'preview.response',
      id: frameId,
      status: 200,
      headers: {},
    };
    try {
      const sent = state.send!(response);
      await until(() => Boolean(release));
      const closing = t.close();
      await retained(closing);
      expect(await state.send!(response)).toBe(false);
      release!();
      await sent;
      await closing;
    } finally {
      release?.();
      spy.mockRestore();
    }
  });
});
