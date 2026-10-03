import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FolderTriggerEventSchema,
  FolderTriggerObservationSchema,
  type FolderTriggerRule,
} from '@allrice/contracts';
import {
  FolderTriggerCore,
  assertFolderTriggerWatcherEnvironment,
  projectFolderTriggerEnvironment,
  probeFolderTriggerRuntime,
} from './core.js';
import { BridgeClientError } from './client.js';
import { BridgeJournal } from './journal.js';
import { fixtureId } from './journal-fixtures.js';
import type { BridgeConfig } from './config.js';
import type { FolderTriggerWatcherOptions } from './folder-trigger-watcher.js';
import { initialBridgeEnvironment } from './runtime-preparation.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'rice-folder-core-')),
  );
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'files');
  await mkdir(root);
  const bodies: Array<{
    path: string;
    body: unknown;
    authorization: string | undefined;
  }> = [];
  let rules: FolderTriggerRule[] = [];
  let eventStatus = 200;
  let acceptedEventId = fixtureId(99);
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown)
        : null;
      bodies.push({
        path: request.url!,
        body,
        authorization: request.headers.authorization,
      });
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== 'Bearer synthetic-core-token') {
        response
          .writeHead(401)
          .end(JSON.stringify({ error: { message: 'DENIED' } }));
        return;
      }
      if (request.url === '/api/v1/bridge/folder-triggers')
        response.end(JSON.stringify({ rules }));
      else if (request.url === '/api/v1/bridge/folder-triggers/events') {
        FolderTriggerEventSchema.parse(body);
        response
          .writeHead(eventStatus)
          .end(
            JSON.stringify(
              eventStatus === 200
                ? { acceptedEventId }
                : { error: { message: 'TEMPORARY' } },
            ),
          );
      } else {
        FolderTriggerObservationSchema.parse(body);
        response.end('{}');
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('fixture server unavailable');
  const endpoint = `http://127.0.0.1:${address.port}/`;
  const rule: FolderTriggerRule = {
    automationId: fixtureId(20),
    revision: 1,
    deviceId: fixtureId(11),
    folderGrantId: fixtureId(21),
    folderGrantVersion: 1,
    relativePath: '.',
    extensions: ['pdf'],
    ignorePaths: ['output'],
    admissionExpiresAt: new Date(Date.now() + 75000).toISOString(),
  };
  rules = [rule];
  let config: BridgeConfig = {
    server: endpoint,
    deviceId: rule.deviceId,
    deviceName: 'own synthetic fixture',
    grants: [
      {
        id: rule.folderGrantId,
        label: 'own directory',
        rootPath: root,
        rootFingerprint: createHash('sha256').update(root).digest('hex'),
      },
    ],
  };
  let token = 'synthetic-core-token';
  const journal = await BridgeJournal.open({
    directory: join(base, 'private'),
    server: endpoint,
    deviceId: rule.deviceId,
  });
  cleanups.push(() => journal.close());
  const metadata = await stat(root);
  const pin = {
    path: root,
    dev: metadata.dev,
    ino: metadata.ino,
    directoryDev: metadata.dev,
    directoryIno: metadata.ino,
  };
  const handles: Array<{
    options: FolderTriggerWatcherOptions;
    start: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    renewAdmission: ReturnType<typeof vi.fn>;
    reconcile: ReturnType<typeof vi.fn>;
  }> = [];
  const signal = new AbortController();
  const drain = new AbortController();
  let available = true;
  const diagnostics: string[] = [];
  const core = new FolderTriggerCore({
    server: endpoint,
    deviceId: rule.deviceId,
    token,
    journal,
    signal: signal.signal,
    drainSignal: drain.signal,
    available: () => available,
    readCredentials: async () => ({ config, token }),
    onDiagnostic: (code) => diagnostics.push(code),
    makeWatcher: (options) => {
      const handle = {
        options,
        start: vi.fn(async () => {
          await options.getRoot(options.rule);
          await journal.commitFolderTriggerSnapshot(
            options.rule,
            pin,
            { files: [], complete: true, truncated: false },
            new Date().toISOString(),
          );
          return {
            complete: true,
            truncated: false,
            observedFiles: 0,
            queuedEvents: 0,
          };
        }),
        close: vi.fn(async () => undefined),
        renewAdmission: vi.fn(async () => {
          await options.authorize?.();
        }),
        reconcile: vi.fn(async () => ({
          complete: true,
          truncated: false,
          observedFiles: 0,
          queuedEvents: 0,
        })),
      };
      handles.push(handle);
      return handle;
    },
  });
  cleanups.push(() => core.close());
  async function initialize() {
    await core.synchronize();
    await vi.waitFor(() => expect(handles[0]?.start).toHaveBeenCalledOnce());
    await handles[0]!.start.mock.results[0]!.value;
    await core.synchronize();
    await core.flush();
  }
  async function event() {
    const result = await journal.recordFolderTrigger(
      rule,
      pin,
      'incoming.pdf',
      {
        checksum: 'sha256:' + 'a'.repeat(64),
        version: 'sha256:' + 'b'.repeat(64),
        sizeBytes: 12,
        mediaType: 'application/pdf',
      },
      new Date().toISOString(),
    );
    if (!result) throw Error('fixture event missing');
    return result;
  }
  return {
    core,
    journal,
    rule,
    handles,
    bodies,
    diagnostics,
    initialize,
    event,
    signal,
    drain,
    root,
    setRules: (next: FolderTriggerRule[]) => {
      rules = next;
    },
    setEventStatus: (next: number) => {
      eventStatus = next;
    },
    setAcceptedId: (next: string) => {
      acceptedEventId = next;
    },
    setConfig: (next: BridgeConfig) => {
      config = next;
    },
    getConfig: () => config,
    setToken: (next: string) => {
      token = next;
    },
    setAvailable: (next: boolean) => {
      available = next;
    },
  };
}

describe('folder triggers on the existing Core heartbeat', () => {
  it('accepts the bounded 32-rule UTF-8 contract without a smaller incidental response cutoff', async () => {
    const f = await fixture();
    const rules = Array.from({ length: 32 }, (_, index) => ({
      ...f.rule,
      automationId: fixtureId(100 + index),
      ignorePaths: Array.from(
        { length: 16 },
        (_, ignored) => '中'.repeat(900) + ignored,
      ),
    }));
    expect(Buffer.byteLength(JSON.stringify({ rules }))).toBeGreaterThan(65536);
    f.setRules(rules);
    await f.core.synchronize();
    await Promise.all(
      f.handles.map((handle) => handle.start.mock.results[0]!.value),
    );
    await f.core.synchronize();
    await f.core.flush();
    expect(f.handles).toHaveLength(32);
    expect(f.diagnostics).toEqual([]);
  });
  it('authenticates exact immutable outbox bytes and clears the original id after a dedup acknowledgement', async () => {
    const f = await fixture();
    await f.initialize();
    const event = await f.event();
    await f.core.flush();
    const calls = f.bodies.filter((v) => v.path.endsWith('/events'));
    expect(calls).toEqual([
      {
        path: '/api/v1/bridge/folder-triggers/events',
        body: event,
        authorization: 'Bearer synthetic-core-token',
      },
    ]);
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
    await f.core.flush();
    expect(f.bodies.filter((v) => v.path.endsWith('/events'))).toHaveLength(1);
  });

  it('preserves the same event and observedAt across transport failure until a valid ACK', async () => {
    const f = await fixture();
    await f.initialize();
    const event = await f.event();
    f.setEventStatus(503);
    await expect(f.core.flush()).rejects.toBeInstanceOf(BridgeClientError);
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
    f.setEventStatus(200);
    f.setAcceptedId(fixtureId(88));
    await f.core.flush();
    expect(
      f.bodies.filter((v) => v.path.endsWith('/events')).map((v) => v.body),
    ).toEqual([event, event]);
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([]);
  });

  it('does not clear a local fact for a malformed acknowledgement', async () => {
    const f = await fixture();
    await f.initialize();
    const event = await f.event();
    f.setAcceptedId('wrong-shape');
    await expect(f.core.flush()).rejects.toThrow();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
  });

  it('ordinary heartbeats renew without reconciling and only write changed observations', async () => {
    const f = await fixture();
    await f.initialize();
    const count = f.bodies.filter((v) =>
      v.path.endsWith('/observations'),
    ).length;
    f.setRules([
      {
        ...f.rule,
        admissionExpiresAt: new Date(Date.now() + 75000).toISOString(),
      },
    ]);
    await f.core.synchronize();
    await f.core.synchronize();
    expect(f.handles[0]?.renewAdmission).toHaveBeenCalled();
    expect(f.handles[0]?.reconcile).not.toHaveBeenCalled();
    expect(
      f.bodies.filter((v) => v.path.endsWith('/observations')),
    ).toHaveLength(count);
    expect(
      f.bodies.filter((v) => v.path.endsWith('/observations')).at(-1)?.body,
    ).toMatchObject({ status: 'listening', errorCode: null });
  });

  it('reconciles once after a transient disconnect using the same scope', async () => {
    const f = await fixture();
    await f.initialize();
    await f.core.connectionFailure(new BridgeClientError('TEMPORARY', 503));
    expect(f.handles[0]?.close).not.toHaveBeenCalled();
    await f.core.synchronize();
    await f.core.synchronize();
    expect(f.handles[0]?.reconcile).toHaveBeenCalledOnce();
    expect(f.handles).toHaveLength(1);
  });

  it('closes canceled rules and never migrates the old outbox into a new revision/grant generation', async () => {
    const f = await fixture();
    await f.initialize();
    const event = await f.event();
    f.setRules([{ ...f.rule, revision: 2, folderGrantVersion: 2 }]);
    await f.core.synchronize();
    await f.core.synchronize();
    await f.core.flush();
    expect(f.handles[0]?.close).toHaveBeenCalled();
    expect(f.handles[1]?.options.rule).toMatchObject({
      revision: 2,
      folderGrantVersion: 2,
    });
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
    expect(f.bodies.filter((v) => v.path.endsWith('/events'))).toEqual([]);
    f.setRules([]);
    await f.core.synchronize();
    expect(f.handles[1]?.close).toHaveBeenCalled();
  });

  it.each(['device', 'token', 'server', 'pause'] as const)(
    'stops before any old-credential delivery when local %s changes',
    async (kind) => {
      const f = await fixture();
      await f.initialize();
      const event = await f.event();
      if (kind === 'token') f.setToken('different-private-token');
      else
        f.setConfig({
          ...f.getConfig(),
          ...(kind === 'device'
            ? { deviceId: fixtureId(12) }
            : kind === 'server'
              ? { server: 'https://other.invalid/' }
              : { paused: true }),
        });
      await expect(f.core.checkScope()).rejects.toThrow();
      expect(f.core.canAdvertise).toBe(false);
      expect(f.handles[0]?.close).toHaveBeenCalled();
      await f.core.flush();
      expect(f.bodies.filter((v) => v.path.endsWith('/events'))).toEqual([]);
      expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
    },
  );

  it.each(['checkScope', 'synchronize'] as const)(
    '%s reports a local pause only after physical release and deduplicates later checks',
    async (method) => {
      const f = await fixture();
      await f.initialize();
      const event = await f.event();
      const released = deferred();
      f.handles[0]!.close.mockImplementation(() => released.promise);
      f.setConfig({ ...f.getConfig(), paused: true });
      const pausing = f.core[method]().catch((error: unknown) => error);
      try {
        await vi.waitFor(() => expect(f.handles[0]!.close).toHaveBeenCalled());
        expect(
          f.bodies.filter((v) => v.path.endsWith('/observations')),
        ).toHaveLength(1);
      } finally {
        released.resolve();
      }
      const result = await pausing;
      if (method === 'checkScope')
        expect(result).toMatchObject({ message: 'FOLDER_TRIGGER_PAUSED' });
      expect(f.core.canAdvertise).toBe(false);
      expect(
        f.bodies
          .filter((v) => v.path.endsWith('/observations'))
          .map((v) => v.body),
      ).toEqual([
        {
          ruleId: f.rule.automationId,
          revision: f.rule.revision,
          status: 'listening',
          errorCode: null,
        },
        {
          ruleId: f.rule.automationId,
          revision: f.rule.revision,
          status: 'paused',
          errorCode: 'FOLDER_TRIGGER_PAUSED',
        },
      ]);
      await expect(f.core.checkScope()).rejects.toThrow(
        'FOLDER_TRIGGER_PAUSED',
      );
      await f.core.synchronize();
      expect(
        f.bodies.filter((v) => v.path.endsWith('/observations')),
      ).toHaveLength(2);
      expect(f.bodies.filter((v) => v.path.endsWith('/events'))).toEqual([]);
      expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
    },
  );

  it('does not send a pause observation with an old pairing after credentials change during physical release', async () => {
    const f = await fixture();
    await f.initialize();
    const released = deferred();
    f.handles[0]!.close.mockImplementation(() => released.promise);
    f.setConfig({ ...f.getConfig(), paused: true });
    const pausing = f.core.checkScope().catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(f.handles[0]!.close).toHaveBeenCalled());
      f.setToken('different-private-token');
    } finally {
      released.resolve();
    }
    await pausing;
    expect(
      f.bodies.filter((v) => v.path.endsWith('/observations')),
    ).toHaveLength(1);
    expect(f.core.canAdvertise).toBe(false);
  });

  it('rejects a symlink root and a rule for a different device before its watcher opens', async () => {
    const f = await fixture();
    const alias = join(f.root, '../alias');
    await symlink(f.root, alias);
    f.setConfig({
      ...f.getConfig(),
      grants: [
        {
          ...f.getConfig().grants[0]!,
          rootPath: alias,
          rootFingerprint: createHash('sha256').update(alias).digest('hex'),
        },
      ],
    });
    await f.core.synchronize();
    await expect(f.handles[0]!.start.mock.results[0]!.value).rejects.toThrow(
      'FOLDER_TRIGGER_ROOT_CHANGED',
    );
    await f.core.synchronize();
    expect(
      f.bodies.filter((v) => v.path.endsWith('/observations')).at(-1)?.body,
    ).toMatchObject({
      status: 'error',
      errorCode: 'FOLDER_TRIGGER_ROOT_CHANGED',
    });
    f.setRules([{ ...f.rule, deviceId: fixtureId(12) }]);
    const previous = f.handles.length;
    await f.core.synchronize();
    expect(f.handles).toHaveLength(previous);
    expect(f.handles.every((v) => v.close.mock.calls.length > 0)).toBe(true);
  });

  it('an authorization refusal closes existing listeners but keeps pending immutable facts', async () => {
    const f = await fixture();
    await f.initialize();
    const event = await f.event();
    await f.core.connectionFailure(new BridgeClientError('DENIED', 403));
    expect(f.handles[0]?.close).toHaveBeenCalled();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
  });

  it('event admission denied by the server stops the watcher without acknowledging or replaying', async () => {
    const f = await fixture();
    await f.initialize();
    const event = await f.event();
    f.setEventStatus(403);
    await expect(f.core.flush()).rejects.toBeInstanceOf(BridgeClientError);
    expect(f.handles[0]?.close).toHaveBeenCalled();
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
    await f.core.flush();
    expect(f.bodies.filter((v) => v.path.endsWith('/events'))).toHaveLength(1);
  });

  it('checks the watcher root pins before sending an immutable pending fact', async () => {
    const f = await fixture();
    await f.initialize();
    const event = await f.event();
    f.handles[0]!.renewAdmission.mockRejectedValue(
      Error('FOLDER_TRIGGER_ROOT_CHANGED'),
    );
    await expect(f.core.flush()).rejects.toThrow('FOLDER_TRIGGER_ROOT_CHANGED');
    expect(f.bodies.filter((v) => v.path.endsWith('/events'))).toEqual([]);
    expect(await f.journal.pendingFolderTriggers(f.rule)).toEqual([event]);
  });

  it('rejects a persisted event whose rule/grant body no longer matches its exact local outbox scope', async () => {
    const f = await fixture();
    await f.initialize();
    const event = await f.event();
    vi.spyOn(f.journal, 'pendingFolderTriggers').mockResolvedValue([
      { ...event, grantVersion: 2 },
    ]);
    await expect(f.core.flush()).rejects.toThrow(
      'FOLDER_TRIGGER_EVENT_INVALID',
    );
    expect(f.bodies.filter((v) => v.path.endsWith('/events'))).toEqual([]);
    expect(f.handles[0]?.close).toHaveBeenCalled();
  });

  it('drain waits for physical watcher release before journal can be closed', async () => {
    const f = await fixture();
    await f.initialize();
    const released = deferred();
    f.handles[0]!.close.mockImplementation(() => released.promise);
    f.drain.abort();
    let closed = false;
    const closing = f.core.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(await f.journal.diagnosticCounts()).toBeDefined();
    released.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(
      f.bodies.filter((v) => v.path.endsWith('/observations')).at(-1)?.body,
    ).toMatchObject({ status: 'paused', errorCode: 'FOLDER_TRIGGER_CLOSED' });
  });
});

it('refuses all forcing Chokidar polling values without altering the environment', () => {
  for (const value of ['1', 'TRUE', 'yes', ' false ', '00'])
    expect(() =>
      assertFolderTriggerWatcherEnvironment({ CHOKIDAR_USEPOLLING: value }),
    ).toThrow('FOLDER_TRIGGER_POLLING_UNSUPPORTED');
  for (const value of [undefined, '', '0', 'FALSE'])
    expect(() =>
      assertFolderTriggerWatcherEnvironment({ CHOKIDAR_USEPOLLING: value }),
    ).not.toThrow();
  vi.stubEnv('CHOKIDAR_USEPOLLING', '1');
  const environment = initialBridgeEnvironment();
  projectFolderTriggerEnvironment(environment, true, false);
  expect(environment.folderTriggerVersion).toBeUndefined();
  expect(process.env.CHOKIDAR_USEPOLLING).toBe('1');
});

it('only advertises folder support after real runtime availability and removes it for pause/stop', async () => {
  const environment = initialBridgeEnvironment();
  projectFolderTriggerEnvironment(environment, false, false);
  expect(environment.folderTriggerVersion).toBeUndefined();
  projectFolderTriggerEnvironment(environment, true, false);
  expect(environment.folderTriggerVersion).toBe(1);
  environment.paused = true;
  projectFolderTriggerEnvironment(environment, true, false);
  expect(environment.folderTriggerVersion).toBeUndefined();
  environment.paused = false;
  projectFolderTriggerEnvironment(environment, true, true);
  expect(environment.folderTriggerVersion).toBeUndefined();
  expect(
    await probeFolderTriggerRuntime({
      journal: null,
      directory: '/must-not-read',
      signal: new AbortController().signal,
    }),
  ).toBe(false);
});
