import { createServer, type Server } from 'node:http';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { platformTechnicalHealth } from './platform-technical-health';

describe('bounded configured technical health probes', () => {
  let server: Server, port: number;
  let reply: { status: number; body: string; service: 'web' | 'worker' };
  const sha = 'b'.repeat(40);
  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.statusCode = reply.status;
      response.setHeader('x-allrice-release-sha', sha);
      response.end(reply.body);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw Error('synthetic_health_address');
    port = address.port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(() => vi.unstubAllEnvs());
  it('uses actual HTTP health and version; raw readiness detail is excluded', async () => {
    vi.stubEnv('ALLRICE_ENV', 'development');
    vi.stubEnv('ALLRICE_WEB_PORT', String(port));
    reply = {
      status: 503,
      service: 'web',
      body: JSON.stringify({
        service: 'web',
        status: 'not_ready',
        detail: 'PRIVATE-db-password',
      }),
    };
    const web = await platformTechnicalHealth('web');
    expect(web).toMatchObject({
      evidence: {
        environment: 'dev',
        freshness: 'fresh',
        source: 'web_health',
      },
      value: { status: 'not_ready', releaseSha: sha },
    });
    expect(JSON.stringify(web)).not.toContain('PRIVATE');
    vi.stubEnv(
      'ALLRICE_TECHNICAL_WORKER_HEALTH_URL',
      `http://127.0.0.1:${port}/health/ready`,
    );
    reply = {
      status: 200,
      service: 'worker',
      body: JSON.stringify({ service: 'worker', status: 'ready' }),
    };
    expect(await platformTechnicalHealth('worker')).toMatchObject({
      value: { status: 'ready', releaseSha: sha },
    });
  });
  it('refuses arbitrary target paths, remote hosts and malformed configuration before fetch', async () => {
    for (const value of [
      'not-a-url',
      'http://example.test/health/ready',
      `http://127.0.0.1:${port}/private`,
      `http://127.0.0.1:${port}/health/ready?token=private`,
    ]) {
      vi.stubEnv('ALLRICE_TECHNICAL_WORKER_HEALTH_URL', value);
      expect(await platformTechnicalHealth('worker')).toMatchObject({
        evidence: { freshness: 'unknown', unavailableReason: 'not_configured' },
        value: null,
      });
    }
  });
  it('marks unavailable, misidentified or oversized health as unknown rather than healthy or offline', async () => {
    vi.stubEnv(
      'ALLRICE_TECHNICAL_WORKER_HEALTH_URL',
      `http://127.0.0.1:${port}/health/ready`,
    );
    for (const body of [
      JSON.stringify({ service: 'web', status: 'ready' }),
      'x'.repeat(9000),
      JSON.stringify({ service: 'worker', status: 'not_ready' }),
    ]) {
      reply = { status: 200, service: 'worker', body };
      expect(await platformTechnicalHealth('worker')).toMatchObject({
        evidence: {
          freshness: 'unknown',
          unavailableReason: 'collection_failed',
        },
        value: null,
      });
    }
    vi.stubEnv(
      'ALLRICE_TECHNICAL_WORKER_HEALTH_URL',
      'http://127.0.0.1:1/health/ready',
    );
    expect(await platformTechnicalHealth('worker')).toMatchObject({
      value: null,
      evidence: { freshness: 'unknown' },
    });
  });
});
