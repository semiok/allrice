import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cloudPlatform, makeHealthResponse } from '@allrice/contracts';
import {
  CloudRunnerBackend,
  CloudRunnerError,
} from './cloud-runner/backend.js';
import { createWorkerReadinessResponder } from './worker-readiness.js';

const servers: Server[] = [];
const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const begin = source.indexOf('const server = createServer(');
const end = source.indexOf('\n\nasync function runClaimed', begin);
if (begin < 0 || end < begin) throw Error('worker_http_handler_missing');
// Execute the shipping handler with fixture DB/controllers and injected cloud
// preflight. This exercises the caller's real readiness calculation, not a
// second implementation or a static health object; full Worker boot is separate.
const handlerSource = ts.transpile(source.slice(begin, end) + '\nserver;', {
  target: ts.ScriptTarget.ES2023,
});
beforeEach(() => {
  vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
  vi.stubEnv('ALLRICE_ENV', 'production');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(CloudRunnerBackend.prototype, 'call').mockResolvedValue(
    Buffer.from('OK'),
  );
  vi.spyOn(CloudRunnerBackend.prototype, 'preflight').mockImplementation(
    async (imageDigest = cloudPlatform.images.node) => ({
      backend: 'cloud-gvisor-v1',
      runtime: 'runsc',
      architecture: cloudPlatform.architecture,
      imageDigest,
    }),
  );
});
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function host(options: { detail?: string; arrivals?: number } = {}) {
  const onReady = vi.fn();
  let count = 0;
  let arrived!: () => void;
  const arrivals = new Promise<void>((resolve) => (arrived = resolve));
  const control = (observeRead = false) => ({
    enabled: true,
    value: { state: 'running' },
    status() {
      if (observeRead && ++count === (options.arrivals ?? 1)) arrived();
      return this.value;
    },
    async observeMaintenance() {},
    async stop() {
      this.value = { state: 'closed' };
    },
  });
  const once = control(true),
    recurring = control();
  const context = {
    createServer,
    process,
    makeHealthResponse,
    nativeRunDiagnosticsHttp: async () => false,
    stopping: false,
    readDevMaintenance: vi.fn(async () => ({ state: 'open' })),
    nativeScheduleControls: [once, recurring],
    nativeOnceControl: once,
    nativeRecurringControl: recurring,
    databaseReady: true,
    lastDatabaseError: undefined as string | undefined,
    serviceBuildIdentity: { sourceSha: 'a'.repeat(40) },
    nativeCloseIdentity: { fixture: 'native-close' },
    nativeArtifact: { artifactId: `sha256:${'b'.repeat(64)}` },
    nativeJournalContract: { highWater: 1 },
    queueWakeup: null,
    readDevProducerLifecycle: () => ({ fixture: true }),
    respondWorkerReadiness: createWorkerReadinessResponder(),
    startup: { mark: onReady },
  };
  if (options.detail?.startsWith('native_once'))
    once.value.state = options.detail.endsWith('blocked')
      ? 'blocked'
      : 'closed';
  else if (options.detail?.startsWith('native_recurring'))
    recurring.value.state = options.detail.endsWith('blocked')
      ? 'blocked'
      : 'closed';
  else if (options.detail === 'dev_maintenance_unavailable')
    context.readDevMaintenance.mockRejectedValue(
      Error('private maintenance failure'),
    );
  else if (options.detail) {
    context.databaseReady = false;
    context.lastDatabaseError = options.detail;
  }
  const server = runInNewContext(handlerSource, context) as Server;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    request: (path = '/health/ready') => fetch(url + path),
    onReady,
    arrivals,
    context,
    once,
    recurring,
    server,
  };
}

it('serves ready only after the actual configured platform images pass the shipping preflight', async () => {
  const h = await host();
  vi.stubEnv('ALLRICE_RELEASE_SHA', 'a'.repeat(40));
  const live = await h.request('/health/live');
  expect(live.status).toBe(200);
  expect((await live.json()).status).toBe('live');
  expect((await h.request('/other')).status).toBe(404);
  expect(CloudRunnerBackend.prototype.call).not.toHaveBeenCalled();
  const response = await h.request();
  expect(response.status).toBe(200);
  expect(response.headers.get('x-allrice-release-sha')).toBe('a'.repeat(40));
  expect(await response.json()).toMatchObject({
    service: 'worker',
    status: 'ready',
    identity: { sourceSha: 'a'.repeat(40) },
    nativeArtifact: { artifactId: `sha256:${'b'.repeat(64)}` },
    maintenance: { state: 'open' },
  });
  expect(CloudRunnerBackend.prototype.call).toHaveBeenCalledExactlyOnceWith(
    'GET',
    '/_ping',
  );
  expect(vi.mocked(CloudRunnerBackend.prototype.preflight).mock.calls).toEqual(
    Object.values(cloudPlatform.images).map((image) => [image]),
  );
  expect(h.onReady).toHaveBeenCalledOnce();
});

it('returns 503 on a Docker failure and detects recovery without retaining the failure or leaking its message', async () => {
  const call = vi.mocked(CloudRunnerBackend.prototype.call);
  call.mockRejectedValueOnce(
    Error('private /host/docker.sock password=secret'),
  );
  const h = await host();
  const failed = await h.request();
  expect(failed.status).toBe(503);
  const body = await failed.json();
  expect(body).toMatchObject({
    status: 'not_ready',
    detail: 'cloud_docker_unavailable',
  });
  expect(
    JSON.stringify([body, vi.mocked(console.error).mock.calls]),
  ).not.toMatch(/\/host\/docker|password|secret/);
  expect(CloudRunnerBackend.prototype.preflight).not.toHaveBeenCalled();
  expect(h.onReady).not.toHaveBeenCalled();
  expect((await h.request()).status).toBe(200);
});

it.each(Object.entries(cloudPlatform.images))(
  'rejects a missing %s image and returns ready when that image is restored',
  async (name, missingImage) => {
    const preflight = vi.mocked(CloudRunnerBackend.prototype.preflight);
    const healthy = preflight.getMockImplementation()!;
    preflight.mockImplementation(async (image) => {
      if (image === missingImage)
        throw new CloudRunnerError('CLOUD_DAEMON_404');
      return healthy(image);
    });
    const h = await host();
    const failed = await h.request();
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      status: 'not_ready',
      detail: `cloud_image_${name}_unavailable`,
    });
    expect(h.onReady).not.toHaveBeenCalled();
    preflight.mockImplementation(healthy);
    expect((await h.request()).status).toBe(200);
    expect(preflight).toHaveBeenCalledTimes(8);
  },
);

it('keeps concurrent requests coalesced until every started image check settles, even after an early failure', async () => {
  let finishImage!: () => void;
  const imagePending = new Promise<void>((resolve) => (finishImage = resolve));
  const preflight = vi.mocked(CloudRunnerBackend.prototype.preflight);
  const healthy = preflight.getMockImplementation()!;
  preflight.mockImplementation(async (image) => {
    if (image === cloudPlatform.images.node)
      throw new CloudRunnerError('CLOUD_DAEMON_404');
    if (image === cloudPlatform.images.python) await imagePending;
    return healthy(image);
  });
  const h = await host({ arrivals: 12 });
  const requests = Array.from({ length: 12 }, () => h.request());
  await h.arrivals;
  expect(CloudRunnerBackend.prototype.call).toHaveBeenCalledTimes(1);
  expect(preflight).toHaveBeenCalledTimes(4);
  finishImage();
  expect(
    (await Promise.all(requests)).map((response) => response.status),
  ).toEqual(Array(12).fill(503));
  expect(preflight).toHaveBeenCalledTimes(4);
  preflight.mockImplementation(healthy);
  expect((await h.request()).status).toBe(200);
  expect(CloudRunnerBackend.prototype.call).toHaveBeenCalledTimes(2);
  expect(preflight).toHaveBeenCalledTimes(8);
});

it.each(['0', undefined])(
  'does not access Docker when this deployment has not enabled cloud execution (%s)',
  async (flag) => {
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', flag);
    const h = await host();
    expect((await h.request()).status).toBe(200);
    expect(CloudRunnerBackend.prototype.call).not.toHaveBeenCalled();
    expect(CloudRunnerBackend.prototype.preflight).not.toHaveBeenCalled();
  },
);

it('honors the existing development feature default instead of bypassing dependencies in development', async () => {
  vi.stubEnv('ALLRICE_ENV', 'development');
  vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', undefined);
  vi.mocked(CloudRunnerBackend.prototype.call).mockRejectedValueOnce(
    Error('daemon unavailable'),
  );
  const h = await host();
  expect((await h.request()).status).toBe(503);
});

it.each([
  'native_once_blocked',
  'native_once_restart_required',
  'native_recurring_blocked',
  'native_recurring_restart_required',
  'dev_maintenance_unavailable',
  'database_unavailable',
])('preserves the existing not-ready reason %s', async (detail) => {
  const h = await host({ detail });
  const response = await h.request();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ status: 'not_ready', detail });
  expect(h.onReady).not.toHaveBeenCalled();
  expect(CloudRunnerBackend.prototype.call).not.toHaveBeenCalled();
});

it.each([
  ['database', 'database_unavailable'],
  ['native_once', 'native_once_blocked'],
  ['native_recurring', 'native_recurring_blocked'],
  ['stopping', 'worker_stopping'],
])(
  'rechecks the real handler after %s changes while a cloud probe is pending',
  async (change, detail) => {
    let started!: () => void;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const arrived = new Promise<void>((resolve) => (started = resolve));
    const preflight = vi.mocked(CloudRunnerBackend.prototype.preflight);
    const healthy = preflight.getMockImplementation()!;
    preflight.mockImplementation(async (image) => {
      if (change === 'database' && image === cloudPlatform.images.node)
        throw new CloudRunnerError('CLOUD_DAEMON_404');
      if (image === cloudPlatform.images.python) {
        started();
        await pending;
      }
      return healthy(image);
    });
    const h = await host();
    const older = h.request();
    await arrived;
    h.context.serviceBuildIdentity = { sourceSha: 'c'.repeat(40) };
    if (change === 'database') {
      h.context.databaseReady = false;
      h.context.lastDatabaseError = detail;
    } else if (change === 'native_once') h.once.value = { state: 'blocked' };
    else if (change === 'native_recurring')
      h.recurring.value = { state: 'blocked' };
    else h.context.stopping = true;
    const newer = await h.request();
    expect(newer.status).toBe(503);
    expect((await newer.json()).detail).toBe(detail);
    finish();
    const response = await older;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: 'not_ready',
      detail,
      identity: { sourceSha: 'c'.repeat(40) },
    });
    expect(preflight).toHaveBeenCalledTimes(4);
    expect(h.onReady).not.toHaveBeenCalled();
  },
);

it('does not finish ready when HTTP shutdown closes controllers during a probe', async () => {
  let started!: () => void;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => (finish = resolve));
  const arrived = new Promise<void>((resolve) => (started = resolve));
  const preflight = vi.mocked(CloudRunnerBackend.prototype.preflight);
  const healthy = preflight.getMockImplementation()!;
  preflight.mockImplementation(async (image) => {
    if (image === cloudPlatform.images.python) {
      started();
      await pending;
    }
    return healthy(image);
  });
  const h = await host();
  const earlier = h.request();
  await arrived;
  h.context.stopping = true;
  await Promise.all([h.once.stop(), h.recurring.stop()]);
  const closed = new Promise<void>((resolve) =>
    h.server.close(() => resolve()),
  );
  finish();
  const response = await earlier;
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    status: 'not_ready',
    detail: 'native_once_restart_required',
    nativeOnceControl: { state: 'closed' },
    nativeRecurringControl: { state: 'closed' },
  });
  expect(h.onReady).not.toHaveBeenCalled();
  await closed;
});
