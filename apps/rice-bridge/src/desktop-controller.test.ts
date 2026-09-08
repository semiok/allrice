import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { BridgeJournal } from './journal.js';
import { journalDispatch, fixtureId } from './journal-fixtures.js';
import { nativeSandboxConfig } from './sandbox-settings.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});
const index = fileURLToPath(new URL('./index.ts', import.meta.url));
const project = fileURLToPath(new URL('../../../', import.meta.url));
const deviceId = '00000000-0000-4000-8000-000000000011';
const supportedNativeSandbox =
  process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch);

async function fixture(paired = true, ledger: boolean | null = false) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'allrice-p13-desktop-')),
  );
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let polls = 0,
    hang = false,
    acknowledgeReceipts = false,
    receiptAttempts = 0,
    operationPolls = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/receipts')) {
      receiptAttempts++;
      if (acknowledgeReceipts)
        response.end(
          JSON.stringify({
            receiptId: JSON.parse(body).receiptId,
            accepted: true,
          }),
        );
      else {
        response.statusCode = 503;
        response.end('{"error":{"message":"offline"}}');
      }
    } else if (request.url?.endsWith('/operations/next')) {
      operationPolls++;
      response.end('{"dispatch":null}');
    } else if (request.url?.endsWith('/workspace-selections/next'))
      response.end('{"request":null}');
    else if (request.url?.endsWith('/commands/next')) {
      polls++;
      if (!hang) response.end('{"command":null}');
    } else if (request.url?.endsWith('/revoke')) {
      response.statusCode = 503;
      response.end(
        '{"error":{"message":"Bearer secret-must-not-be-exported"}}',
      );
    } else response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error();
  const config = {
    deviceId,
    server: `http://127.0.0.1:${address.port}/`,
    deviceName: 'Synthetic desktop',
    grants: [
      {
        id: '00000000-0000-4000-8000-000000000012',
        label: 'Synthetic workspace',
        rootPath: root,
        rootFingerprint: 'a'.repeat(64),
      },
    ],
  };
  const path = join(root, 'config.json');
  if (paired) await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const launch = (command = 'desktop') => {
    const child = spawn(process.execPath, ['--import', 'tsx', index, command], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ALLRICE_BRIDGE_CONFIG_PATH: path,
        ALLRICE_BRIDGE_DEVICE_TOKEN: 'synthetic-secret-token',
        // Never probe the developer's real allrice-b2 VM for this protocol test.
        ALLRICE_LOCAL_DOCKER_SOCKET: join(root, 'absent-test-docker.sock'),
        TSX_TSCONFIG_PATH: join(project, 'tsconfig.base.json'),
        ...(ledger === null
          ? {}
          : { ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: ledger ? '1' : '0' }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    const frames: Record<string, unknown>[] = [];
    child.stdout.on('data', (bytes: Buffer) => {
      stdout += bytes;
    });
    let buffer = '';
    child.stdout.on('data', (bytes: Buffer) => {
      buffer += bytes;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          frames.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          /* CLI startup failures are not protocol output. */
        }
      }
    });
    child.stderr.on('data', (bytes: Buffer) => {
      stderr += bytes;
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, 'exit');
        child.kill('SIGKILL');
        await exit;
      }
    });
    let id = 0;
    const request = async (
      type: string,
      fields: Record<string, unknown> = {},
    ) => {
      const current = `r${++id}`;
      child.stdin.write(
        JSON.stringify({ v: 1, id: current, type, ...fields }) + '\n',
      );
      await wait(() =>
        frames.some(
          (frame) => frame.type === 'response' && frame.id === current,
        ),
      );
      return frames.find(
        (frame) => frame.type === 'response' && frame.id === current,
      )!;
    };
    return { child, frames, request, text: () => stdout + stderr };
  };
  return {
    root,
    path,
    config,
    launch,
    polls: () => polls,
    operationPolls: () => operationPolls,
    receiptAttempts: () => receiptAttempts,
    acknowledge: () => {
      acknowledgeReceipts = true;
    },
    hang: () => {
      hang = true;
    },
  };
}
async function wait(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(30);
  }
  throw Error('desktop fixture wait timed out');
}
async function exited(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
}

it('real CLI desktop keeps existing pairing, pauses pending polling, resumes and stops without secrets', async () => {
  const f = await fixture();
  const app = f.launch();
  await wait(() => f.polls() > 0);
  f.hang();
  await wait(() => f.polls() > 1);
  expect((await app.request('pause')).ok).toBe(true);
  const paused = f.polls();
  await delay(100);
  expect(f.polls()).toBe(paused);
  expect((await app.request('status')).data).toMatchObject({
    mode: 'paused',
    activeForeground: 0,
    activeServices: 0,
  });
  expect((await app.request('diagnostics')).data).not.toHaveProperty('server');
  expect((await app.request('resume')).ok).toBe(true);
  await wait(() => f.polls() > paused);
  expect((await app.request('stop')).ok).toBe(true);
  await exited(app.child);
  expect(app.child.exitCode).toBe(0);
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.config);
  expect(app.text()).not.toContain('synthetic-secret-token');
}, 15_000);

it('new GUI and CLI cannot double-consume even with operation ledger disabled; crash releases owner', async () => {
  const f = await fixture();
  const first = f.launch();
  await wait(() => f.polls() > 0);
  const second = f.launch('start');
  await exited(second.child);
  expect(second.child.exitCode).toBe(1);
  expect(second.text()).toContain('BRIDGE_ALREADY_RUNNING');
  const third = f.launch();
  await exited(third.child);
  expect(third.frames).toContainEqual({
    v: 1,
    type: 'fatal',
    code: 'BRIDGE_ALREADY_RUNNING',
  });
  first.child.kill('SIGKILL');
  await exited(first.child);
  const recovered = f.launch();
  await wait(() => recovered.frames.some((frame) => frame.type === 'state'));
  await recovered.request('stop');
  await exited(recovered.child);
  expect(recovered.child.exitCode).toBe(0);
}, 15_000);

it('EOF stops the owned core and failed server revoke retains pairing with safe diagnostics', async () => {
  const f = await fixture();
  const app = f.launch();
  await wait(() => f.polls() > 0);
  const response = await app.request('revoke', { confirmDeviceId: deviceId });
  expect(response).toMatchObject({ ok: false, code: 'BRIDGE_ACTION_FAILED' });
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.config);
  expect(JSON.stringify(await app.request('diagnostics'))).not.toContain(
    'secret-must-not-be-exported',
  );
  app.child.stdin.end();
  await exited(app.child);
  expect(app.child.exitCode).toBe(0);
}, 15_000);

it('P13 pause and resume retain the real SQLite outbox and only redeliver its receipt', async () => {
  const f = await fixture(true, true);
  const identity = {
    directory: `${f.path}.operation-journal`,
    server: f.config.server,
    deviceId,
  };
  const journal = await BridgeJournal.open(identity);
  const dispatch = journalDispatch(f.root);
  await journal.receive(dispatch);
  await journal.outcome(fixtureId(6), {
    status: 'succeeded',
    effects: 'applied',
    summary: 'previous completed synthetic effect',
  });
  await journal.close();
  await writeFile(join(f.root, 'effect.txt'), 'one prior effect');
  const app = f.launch();
  await wait(() => f.receiptAttempts() > 0);
  expect((await app.request('pause')).ok).toBe(true);
  expect((await app.request('diagnostics')).data).toMatchObject({
    pendingReceipts: 1,
    unknownOperations: 0,
  });
  const paused = await BridgeJournal.open(identity);
  expect(await paused.pending()).toHaveLength(1);
  await paused.close();
  f.acknowledge();
  expect((await app.request('resume')).ok).toBe(true);
  await wait(() => f.polls() > 0);
  await app.request('pause');
  const reopened = await BridgeJournal.open(identity);
  expect(await reopened.pending()).toHaveLength(0);
  expect(await reopened.receive(dispatch)).toBe('duplicate');
  await reopened.close();
  expect(await readFile(join(f.root, 'effect.txt'), 'utf8')).toBe(
    'one prior effect',
  );
  await app.request('stop');
  await exited(app.child);
}, 15_000);

it('unpaired state remains operable; malformed control input fails closed and exits', async () => {
  const f = await fixture(false);
  const app = f.launch();
  await wait(() => app.frames.some((frame) => frame.type === 'state'));
  expect((await app.request('status')).data).toMatchObject({
    mode: 'unpaired',
    deviceId: null,
  });

  expect(await app.request('resume')).toMatchObject({
    ok: false,
    code: 'DESKTOP_PAIRING_REQUIRED',
  });
  app.child.stdin.write(
    '{"v":1,"id":"evil","type":"execute","command":"echo secret"}\n',
  );
  await exited(app.child);
  expect(f.polls()).toBe(0);
  expect(app.frames).toContainEqual({
    v: 1,
    type: 'protocolError',
    code: 'DESKTOP_REQUEST_INVALID',
  });
}, 15_000);

it('a failed runtime cannot be relabelled paused or acknowledged as a clean stop', async () => {
  const f = await fixture(true, true);
  // A file where the owned journal directory must be: fail before execution.
  await writeFile(`${f.path}.operation-journal`, 'not a journal directory', {
    mode: 0o600,
  });
  const app = f.launch();
  await wait(() =>
    app.frames.some(
      (frame) =>
        frame.type === 'state' &&
        (frame.state as { mode?: string })?.mode === 'error',
    ),
  );
  expect(await app.request('pause')).toMatchObject({
    ok: false,
    code: 'DESKTOP_STOP_UNCONFIRMED',
  });
  expect((await app.request('status')).data).toMatchObject({ mode: 'error' });
  expect(await app.request('stop')).toMatchObject({
    ok: false,
    code: 'DESKTOP_STOP_UNCONFIRMED',
  });
  await exited(app.child);
  expect(app.child.exitCode).toBe(1);
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.config);
});

it.skipIf(!supportedNativeSandbox)(
  'saved macOS sandbox opt-in enables the operation protocol without an operation environment flag',
  async () => {
    const f = await fixture(true, null);
    await writeFile(
      `${f.path}.sandbox.json`,
      JSON.stringify({
        version: 1,
        enabled: true,
        deviceId,
        server: f.config.server,
      }),
      { mode: 0o600 },
    );
    const app = f.launch();
    await wait(() => f.operationPolls() > 0);
    expect((await app.request('status')).data).toMatchObject({
      credentialStorage: 'environment',
    });
    expect((await app.request('pause')).ok).toBe(true);
    const count = f.operationPolls();
    await delay(150);
    expect(f.operationPolls()).toBe(count);
    await app.request('stop');
    await exited(app.child);
    expect(app.child.exitCode).toBe(0);
  },
  15_000,
);

it.skipIf(supportedNativeSandbox)(
  'saved sandbox opt-in rejects an unsupported native platform without polling or pretending to be paused',
  async () => {
    expect(() => nativeSandboxConfig()).toThrow('UNSUPPORTED_NATIVE_PLATFORM');
    const f = await fixture(true, null);
    await writeFile(
      `${f.path}.sandbox.json`,
      JSON.stringify({
        version: 1,
        enabled: true,
        deviceId,
        server: f.config.server,
      }),
      { mode: 0o600 },
    );
    const app = f.launch();
    await wait(() =>
      app.frames.some(
        (frame) =>
          frame.type === 'state' &&
          (frame.state as { mode?: string })?.mode === 'error',
      ),
    );
    expect(f.operationPolls()).toBe(0);
    expect(f.polls()).toBe(0);
    expect((await app.request('status')).data).toMatchObject({ mode: 'error' });
    expect(await app.request('pause')).toMatchObject({
      ok: false,
      code: 'DESKTOP_STOP_UNCONFIRMED',
    });
    expect(await app.request('stop')).toMatchObject({
      ok: false,
      code: 'DESKTOP_STOP_UNCONFIRMED',
    });
    await exited(app.child);
    expect(app.child.exitCode).toBe(1);
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.config);
  },
  15_000,
);
