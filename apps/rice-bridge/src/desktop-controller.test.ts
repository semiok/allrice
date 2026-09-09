import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
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
type Observation = {
  child: ChildProcessWithoutNullStreams;
  startedAt: number;
  closed: boolean;
  spawnError: string | null;
  stdinFailed: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  frames: Record<string, unknown>[];
};
const observations = new WeakMap<ChildProcessWithoutNullStreams, Observation>();
const startupWaitMs = 10_000;
const ordinaryWaitMs = 3_000;
const shutdownWaitMs = 7_000; // The enabled ledger may flush for up to 5s.
const exitWaitMs = 5_000;
const allowedCodes = new Set([
  'BRIDGE_ALREADY_RUNNING',
  'BRIDGE_START_FAILED',
  'BRIDGE_ACTION_FAILED',
  'DESKTOP_CONFIG_INVALID',
  'DESKTOP_CREDENTIAL_UNAVAILABLE',
  'DESKTOP_REQUEST_INVALID',
  'DESKTOP_STOP_UNCONFIRMED',
  'DESKTOP_PAIRING_REQUIRED',
  'UNSUPPORTED_NATIVE_PLATFORM',
]);
function safeValue(value: unknown, allowed: readonly string[]) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}
function lastState(observation: Observation) {
  const state = observation.frames.findLast(
    (frame) => frame.type === 'state',
  )?.state;
  return state && typeof state === 'object'
    ? (state as Record<string, unknown>)
    : null;
}
function fixtureFailure(
  phase: string,
  reason: string,
  observation?: Observation,
) {
  const state = observation ? lastState(observation) : null;
  // No child text, paths, environment, token-bearing error.message or arbitrary
  // protocol fields enter a CI failure. These values are fixed or allowlisted.
  return Error(
    `desktop fixture ${JSON.stringify({
      phase,
      reason,
      pid: observation?.child.pid ?? null,
      elapsedMs: observation
        ? Math.round(performance.now() - observation.startedAt)
        : null,
      exitCode: observation?.child.exitCode ?? null,
      signal: safeValue(observation?.child.signalCode, [
        'SIGKILL',
        'SIGTERM',
        'SIGINT',
        'SIGABRT',
        'SIGSEGV',
      ]),
      closed: observation?.closed ?? null,
      spawnError: observation?.spawnError ?? null,
      stdinFailed: observation?.stdinFailed ?? false,
      stdoutBytes: observation?.stdoutBytes ?? 0,
      stderrBytes: observation?.stderrBytes ?? 0,
      frameCounts: Object.fromEntries(
        ['state', 'response', 'fatal', 'protocolError'].map((type) => [
          type,
          observation?.frames.filter((frame) => frame.type === type).length ??
            0,
        ]),
      ),
      mode: safeValue(state?.mode, [
        'unpaired',
        'running',
        'paused',
        'pausing',
        'stopping',
        'error',
      ]),
      connection: safeValue(state?.connection, [
        'online',
        'offline',
        'connecting',
        'stopped',
      ]),
      code:
        typeof state?.errorCode === 'string' &&
        allowedCodes.has(state.errorCode)
          ? state.errorCode
          : null,
    })}`,
  );
}

async function fixture(
  paired = true,
  ledger: boolean | null = false,
  credentialReason?: string,
) {
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
  if (credentialReason) {
    await mkdir(`${path}.credentials`, { mode: 0o700 });
    await writeFile(
      join(`${path}.credentials`, `${deviceId}.json`),
      JSON.stringify({
        version: 1,
        deviceId,
        storage: 'private-file',
        token: 'synthetic-secret-token',
        keychainUnavailableReason: credentialReason,
      }),
      { mode: 0o600 },
    );
  }
  const launch = (command = 'desktop') => {
    const child = spawn(process.execPath, ['--import', 'tsx', index, command], {
      cwd: project,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        ALLRICE_BRIDGE_CONFIG_PATH: path,
        ...(credentialReason
          ? {}
          : { ALLRICE_BRIDGE_DEVICE_TOKEN: 'synthetic-secret-token' }),
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
    const observation: Observation = {
      child,
      startedAt: performance.now(),
      closed: false,
      spawnError: null,
      stdinFailed: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      frames,
    };
    observations.set(child, observation);
    child.on('error', (error: NodeJS.ErrnoException) => {
      observation.spawnError =
        safeValue(error.code, [
          'ENOENT',
          'EACCES',
          'ENOEXEC',
          'EMFILE',
          'ENFILE',
        ]) ?? 'UNKNOWN';
    });
    child.once('close', () => {
      observation.closed = true;
    });
    child.stdin.on('error', () => {
      observation.stdinFailed = true;
    });
    child.stdout.on('data', (bytes: Buffer) => {
      observation.stdoutBytes += bytes.length;
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
      observation.stderrBytes += bytes.length;
      stderr += bytes;
    });
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited(child);
    });
    const ready = () =>
      wait(() => frames.some((frame) => frame.type === 'state'), {
        observation,
        phase: 'source-startup',
        timeoutMs: startupWaitMs,
      });
    const waitUntil = async (predicate: () => boolean) => {
      // node --import tsx loads/transpiles the source before the first frame.
      // Whole-repository parallel runs can exceed 3s here. Once the protocol
      // is live, the original 3s assertion budget remains unchanged.
      await ready();
      await wait(predicate, { observation, phase: 'ready-condition' });
    };
    let id = 0;
    const request = async (
      type: string,
      fields: Record<string, unknown> = {},
    ) => {
      await ready();
      if (
        observation.stdinFailed ||
        child.exitCode !== null ||
        child.signalCode !== null
      )
        throw fixtureFailure('request', 'child-not-writable', observation);
      const current = `r${++id}`;
      child.stdin.write(
        JSON.stringify({ v: 1, id: current, type, ...fields }) + '\n',
      );
      await wait(
        () =>
          frames.some(
            (frame) => frame.type === 'response' && frame.id === current,
          ),
        {
          observation,
          phase:
            type === 'pause' || type === 'stop'
              ? 'shutdown-request'
              : 'request',
          timeoutMs:
            ledger !== false && (type === 'pause' || type === 'stop')
              ? shutdownWaitMs
              : ordinaryWaitMs,
        },
      );
      return frames.find(
        (frame) => frame.type === 'response' && frame.id === current,
      )!;
    };
    return { child, frames, request, waitUntil, text: () => stdout + stderr };
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
async function wait(
  predicate: () => boolean,
  options: {
    observation?: Observation;
    phase?: string;
    timeoutMs?: number;
    allowTermination?: boolean;
  } = {},
) {
  const {
    observation,
    phase = 'condition',
    timeoutMs = ordinaryWaitMs,
    allowTermination = false,
  } = options;
  const deadline = performance.now() + timeoutMs;
  while (true) {
    // Expected negative cases may intentionally wait for an error state/exit.
    if (predicate()) return;
    if (observation?.spawnError && !allowTermination)
      throw fixtureFailure(phase, 'spawn-failed', observation);
    if (observation && !allowTermination) {
      if (
        observation.stdinFailed &&
        (phase === 'request' || phase === 'shutdown-request')
      )
        throw fixtureFailure(phase, 'stdin-write-failed', observation);
      if (
        observation.child.exitCode !== null ||
        observation.child.signalCode !== null ||
        observation.closed
      )
        throw fixtureFailure(
          phase,
          'child-exited-before-condition',
          observation,
        );
      if (
        observation.frames.some(
          (frame) => frame.type === 'fatal' || frame.type === 'protocolError',
        )
      )
        throw fixtureFailure(phase, 'terminal-protocol-frame', observation);
      if (
        phase === 'ready-condition' &&
        lastState(observation)?.mode === 'error'
      )
        throw fixtureFailure(
          phase,
          'runtime-error-before-condition',
          observation,
        );
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw fixtureFailure(phase, 'deadline-exceeded', observation);
    await delay(Math.min(30, remaining));
  }
}
async function exited(child: ChildProcessWithoutNullStreams) {
  const observation = observations.get(child);
  if (!observation) throw Error('desktop fixture unobserved child');
  // close follows exit and stdout/stderr drain; lock-rejection assertions must
  // not race the final fatal frame. A CLI lock rejection also needs source startup.
  await wait(() => observation.closed, {
    observation,
    phase: 'close',
    allowTermination: true,
    timeoutMs:
      child.exitCode !== null ||
      child.signalCode !== null ||
      observation.frames.length > 0
        ? exitWaitMs
        : startupWaitMs,
  });
}

function syntheticObservation(patch: Partial<Observation> = {}): Observation {
  return {
    child: {
      pid: 123,
      exitCode: null,
      signalCode: null,
    } as ChildProcessWithoutNullStreams,
    startedAt: performance.now(),
    closed: false,
    spawnError: null,
    stdinFailed: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    frames: [],
    ...patch,
  };
}

it('fixture wait rejects failed children before its deadline without leaking protocol content', async () => {
  const observation = syntheticObservation({
    closed: true,
    frames: [
      {
        type: 'state',
        state: {
          mode: 'error',
          errorCode: 'synthetic-secret-must-not-leak',
          server: '/private/synthetic-path',
        },
      },
    ],
  });
  const failure = await wait(() => false, {
    observation,
    phase: 'source-startup',
    timeoutMs: 0,
  }).catch((error: Error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('child-exited-before-condition');
  expect((failure as Error).message).not.toContain('deadline-exceeded');
  expect((failure as Error).message).not.toContain('synthetic-secret');
  expect((failure as Error).message).not.toContain('/private/');
});

it('fixture wait fails early on spawn and stdin errors but permits intentional terminal predicates', async () => {
  const observation = syntheticObservation({ spawnError: 'ENOENT' });
  await expect(
    wait(() => false, { observation, phase: 'source-startup', timeoutMs: 0 }),
  ).rejects.toThrow('spawn-failed');
  observation.spawnError = null;
  observation.stdinFailed = true;
  await expect(
    wait(() => false, { observation, phase: 'request', timeoutMs: 0 }),
  ).rejects.toThrow('stdin-write-failed');
  observation.frames.push({ type: 'fatal' });
  await expect(wait(() => true, { observation })).resolves.toBeUndefined();
});

it('fixture close waits for pipe drain after a spawn error but remains bounded', async () => {
  const observation = syntheticObservation({ spawnError: 'ENOENT' });
  await expect(
    wait(() => observation.closed, {
      observation,
      phase: 'close',
      allowTermination: true,
      timeoutMs: 0,
    }),
  ).rejects.toThrow('deadline-exceeded');
  observation.closed = true;
  await expect(
    wait(() => observation.closed, {
      observation,
      phase: 'close',
      allowTermination: true,
      timeoutMs: 0,
    }),
  ).resolves.toBeUndefined();
});

it('real CLI desktop keeps existing pairing, pauses pending polling, resumes and stops without secrets', async () => {
  const f = await fixture();
  const app = f.launch();
  await app.waitUntil(() => f.polls() > 0);
  f.hang();
  await app.waitUntil(() => f.polls() > 1);
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
  await app.waitUntil(() => f.polls() > paused);
  expect((await app.request('stop')).ok).toBe(true);
  await exited(app.child);
  expect(app.child.exitCode).toBe(0);
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.config);
  expect(app.text()).not.toContain('synthetic-secret-token');
}, 15_000);

it('desktop browser disable is explicit, survives reopening, and preserves pairing', async () => {
  const f = await fixture();
  const app = f.launch();
  await app.waitUntil(() => f.polls() > 0);
  expect((await app.request('status')).data).toMatchObject({
    browserEnabled: false,
  });
  expect((await app.request('browser', { enabled: false })).ok).toBe(true);
  expect((await app.request('status')).data).toMatchObject({
    browserEnabled: false,
  });
  const saved = JSON.parse(
    await readFile(`${f.path}.browser-settings/opt-in.json`, 'utf8'),
  );
  expect(saved).toEqual({
    version: 1,
    enabled: false,
    deviceId,
    server: f.config.server,
  });
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.config);
  await app.request('stop');
  await exited(app.child);
  const reopened = f.launch();
  await reopened.waitUntil(() =>
    reopened.frames.some((frame) => frame.type === 'state'),
  );
  expect((await reopened.request('status')).data).toMatchObject({
    browserEnabled: false,
  });
  await reopened.request('stop');
  await exited(reopened.child);
}, 15000);

it.each([
  'interaction-not-allowed',
  'item-not-found',
  'timed-out',
  'unavailable',
])(
  'real desktop core projects only the safe %s reason from a device-bound private fixture',
  async (reason) => {
    // This is a real core process and a real private file, not an OS Keychain
    // test. A committed private source must never query the system Keychain.
    const f = await fixture(true, false, reason);
    const app = f.launch();
    await app.waitUntil(() => f.polls() > 0);
    expect((await app.request('status')).data).toMatchObject({
      credentialStorage: 'private-file',
      credentialFileSecure: true,
      keychainUnavailableReason: reason,
    });
    expect((await app.request('diagnostics')).data).toMatchObject({
      credentialStorage: 'private-file',
      keychainUnavailableReason: reason,
    });
    expect((await app.request('stop')).ok).toBe(true);
    await exited(app.child);
    expect(app.child.exitCode).toBe(0);
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.config);
    expect(app.text()).not.toContain('synthetic-secret-token');
    expect(app.text()).not.toContain(f.root);
  },
  15_000,
);

it('rejects a forged credential reason without exporting its content or requesting another pairing', async () => {
  const f = await fixture(true, false, 'synthetic-secret-forged-reason');
  const app = f.launch();
  await app.waitUntil(() => app.frames.some((frame) => frame.type === 'state'));
  expect((await app.request('status')).data).toMatchObject({
    mode: 'error',
    errorCode: 'DESKTOP_CREDENTIAL_UNAVAILABLE',
    keychainUnavailableReason: null,
    deviceId,
  });
  expect(f.polls()).toBe(0);
  expect((await app.request('stop')).ok).toBe(true);
  await exited(app.child);
  expect(app.text()).not.toContain('synthetic-secret-forged-reason');
  expect(app.text()).not.toContain('synthetic-secret-token');
  expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.config);
}, 15_000);

it('new GUI and CLI cannot double-consume even with operation ledger disabled; crash releases owner', async () => {
  const f = await fixture();
  const first = f.launch();
  await first.waitUntil(() => f.polls() > 0);
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
  await recovered.waitUntil(() =>
    recovered.frames.some((frame) => frame.type === 'state'),
  );
  await recovered.request('stop');
  await exited(recovered.child);
  expect(recovered.child.exitCode).toBe(0);
}, 15_000);

it('EOF stops the owned core and failed server revoke retains pairing with safe diagnostics', async () => {
  const f = await fixture();
  const app = f.launch();
  await app.waitUntil(() => f.polls() > 0);
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
  await app.waitUntil(() => f.receiptAttempts() > 0);
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
  await app.waitUntil(() => f.polls() > 0);
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
  await app.waitUntil(() => app.frames.some((frame) => frame.type === 'state'));
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
  await app.waitUntil(() =>
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
  expect(await app.request('browser', { enabled: true })).toMatchObject({
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
    await app.waitUntil(() => f.operationPolls() > 0);
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
    await app.waitUntil(() =>
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
