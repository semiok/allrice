import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import type * as Preparation from './runtime-preparation.js';

// Only the VM and unrelated browser are simulated. Core, Python preflight,
// Engine HTTP cancellation and journal ownership use their real code.
vi.mock('./runtime-preparation.js', async (original) => ({
  ...(await original<typeof Preparation>()),
  prepareBridgeBrowser: async () => 'paused',
  bridgePreviewState: async () => 'paused',
}));
import { start, type BridgeRuntimeState } from './core.js';
import { ManagedPythonSandbox } from './managed-python-sandbox.js';
import { BridgeJournal } from './journal.js';
import { LocalCommandError } from './local-command-inputs.js';
import { LocalPythonRunner } from './local-python-runner.js';
import { DesktopShutdown } from './desktop-shutdown.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp('/tmp/ar-bq-core-');
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  cleanup.push(async () => {
    Object.defineProperty(process, 'platform', platform);
  });
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => close(server));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture address');
  const path = join(root, 'config.json');
  const config = {
    deviceId: randomUUID(),
    deviceName: 'Synthetic preparation quit',
    grants: [],
    server: `http://127.0.0.1:${address.port}/`,
  };
  const bytes = JSON.stringify(config);
  await writeFile(path, bytes, { mode: 0o600 });
  vi.stubEnv('ALLRICE_BRIDGE_CONFIG_PATH', path);
  vi.stubEnv('ALLRICE_BRIDGE_DEVICE_TOKEN', 'synthetic-preparation-token');
  vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
  vi.stubEnv('ALLRICE_BRIDGE_WSS_ENABLED', '0');
  vi.stubEnv('ALLRICE_LOCAL_COMMAND_ENABLED', '0');
  vi.stubEnv('ALLRICE_LOCAL_DOCKER_SOCKET', '');
  vi.spyOn(ManagedPythonSandbox.prototype, 'prepareVM').mockResolvedValue();
  const stopped = vi
    .spyOn(ManagedPythonSandbox.prototype, 'stop')
    .mockResolvedValue();
  const open = BridgeJournal.open.bind(BridgeJournal);
  vi.spyOn(BridgeJournal, 'open').mockImplementation(async (options) => {
    const journal = await open(options);
    cleanup.push(() => journal.close());
    return journal;
  });
  return { root, path, bytes, stopped };
}

function close(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

it('quits during real Python Engine preparation and preserves pairing instead of continuing image work', async () => {
  const f = await fixture();
  const socket = join(f.root, 'engine.sock');
  let reached!: () => void;
  const reading = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const requests: string[] = [];
  const engine = createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === '/v1.45/info') reached();
    else {
      response.statusCode = 500;
      response.end('{}');
    }
  });
  engine.listen(socket);
  await once(engine, 'listening');
  cleanup.push(() => close(engine));
  // The real runner is created by the real manager; redirect its private API
  // socket to this fixture, without enabling a production environment override.
  const verify = LocalPythonRunner.prototype.preflight;
  vi.spyOn(LocalPythonRunner.prototype, 'preflight').mockImplementation(
    function (this: LocalPythonRunner, signal, deep) {
      Reflect.set(this.api, 'socketPath', socket);
      return verify.call(this, signal, deep);
    },
  );
  const abort = new AbortController();
  cleanup.push(async () => {
    abort.abort();
  });
  const shutdown = new DesktopShutdown(() => {});
  cleanup.push(async () => shutdown.dispose());
  const states: BridgeRuntimeState[] = [];
  const pending = start({
    signal: abort.signal,
    onReady: async () => {},
    onState: (state) => states.push(state),
    onStopPhase: (phase) => shutdown.enter(phase),
    onPreparationStep: (event) => shutdown.observePreparation(event),
  });
  try {
    await Promise.race([
      reading,
      delay(5000).then(() => {
        throw Error('Engine preparation not reached');
      }),
    ]);
    shutdown.begin();
    abort.abort();
    await Promise.race([
      pending,
      delay(5000).then(() => {
        throw Error('Preparation cancellation did not settle');
      }),
    ]);
    expect(requests).toEqual(['/v1.45/info']);
    expect(f.stopped).toHaveBeenCalledOnce();
    expect(states.at(-1)?.phase).toBe('stopped');
    expect(shutdown.snapshot()?.preparation.history).toContainEqual(
      expect.objectContaining({
        component: 'python',
        step: 'engine_info',
        state: 'failed',
      }),
    );
    expect(await readFile(f.path, 'utf8')).toBe(f.bytes);
  } finally {
    abort.abort();
    engine.closeAllConnections();
    await pending.catch(() => {});
  }
}, 20_000);

it('does not turn an unconfirmed preparation cleanup into a successful Core stop', async () => {
  const f = await fixture();
  let reached!: () => void;
  const failed = new Promise<void>((resolve) => {
    reached = resolve;
  });
  vi.spyOn(LocalPythonRunner.prototype, 'preflight').mockImplementation(
    async () => {
      reached();
      throw new LocalCommandError('STOP_NOT_CONFIRMED');
    },
  );
  const states: BridgeRuntimeState[] = [];
  const abort = new AbortController();
  const pending = start({
    signal: abort.signal,
    onReady: async () => {},
    onState: (state) => states.push(state),
  });
  void pending.catch(() => {});
  try {
    await failed;
    await delay(10);
    abort.abort();
    await expect(pending).rejects.toThrow('STOP_NOT_CONFIRMED');
    expect(f.stopped).toHaveBeenCalledOnce();
    expect(states.at(-1)?.phase).toBe('stopping');
    expect(await readFile(f.path, 'utf8')).toBe(f.bytes);
  } finally {
    abort.abort();
    await pending.catch(() => {});
  }
}, 20_000);
