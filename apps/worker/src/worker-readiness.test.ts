import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cloudPlatform, makeHealthResponse } from '@allrice/contracts';
import {
  CloudRunnerBackend,
  CloudRunnerError,
} from './cloud-runner/backend.js';
import { createWorkerReadinessResponder } from './worker-readiness.js';

const servers: Server[] = [];
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
  const respond = createWorkerReadinessResponder();
  const onReady = vi.fn();
  let count = 0;
  let arrived!: () => void;
  const arrivals = new Promise<void>((resolve) => (arrived = resolve));
  const server = createServer(async (request, response) => {
    if (request.url !== '/health/ready') {
      response.writeHead(404).end();
      return;
    }
    if (++count === (options.arrivals ?? 1)) arrived();
    await respond(
      response,
      {
        ...makeHealthResponse(
          'worker',
          options.detail ? 'not_ready' : 'ready',
          options.detail,
        ),
        identity: { sourceSha: 'a'.repeat(40) },
        nativeArtifact: { artifactId: `sha256:${'b'.repeat(64)}` },
        maintenance: { state: 'open' },
      },
      onReady,
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health/ready`;
  return { request: () => fetch(url), onReady, arrivals };
}

it('serves ready only after the actual configured platform images pass the shipping preflight', async () => {
  const h = await host();
  const response = await h.request();
  expect(response.status).toBe(200);
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
