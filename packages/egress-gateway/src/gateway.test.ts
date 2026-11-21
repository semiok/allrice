import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:net';
import type { RequestContext } from '@allrice/contracts';
import type { PersonVmBinding } from '@allrice/person-vm';
import { createEgressGateway } from './gateway.js';
import { createOkxMarketRoutes, createPackageMirrorRoutes } from './routes.js';
import {
  EgressError,
  type EgressResponse,
  type GuestEgressAccess,
} from './contract.js';
import { createHash } from 'node:crypto';

const signal = () => new AbortController().signal;
const binding: PersonVmBinding = {
  vmId: 'vm-a',
  personId: 'person-a',
  organizationId: 'org-a',
  instanceId: 'instance-a',
  leaseEpoch: 1,
};
const asJson = (value: unknown): EgressResponse => ({
  status: 200,
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(value)),
});
const candles = {
  code: '0',
  data: [['1000', '1', '2', '1', '2', '10', '10', '10', '1']],
};
const budgets = { maxResponseBytes: 100000, timeoutMs: 5000 };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
async function fixture(
  extra: Partial<Parameters<typeof createEgressGateway>[0]> = {},
) {
  const port = await freePort();
  let access: GuestEgressAccess | undefined;
  let current = binding;
  const revoked: PersonVmBinding[] = [];
  const upstream = vi.fn(async () => asJson(candles));
  const authority = {
    context: vi.fn(
      async () =>
        ({
          actor: { id: 'person-a' },
          organizationId: 'org-a',
        }) as RequestContext,
    ),
    allow: vi.fn(async () => {}),
  };
  const gateway = createEgressGateway({
    policy: {
      routes: createOkxMarketRoutes({
        ...budgets,
        symbols: ['ETH-USDT', 'BTC-USDT'],
        bars: ['4H', '1D'],
        maxCandles: 100,
      }),
    },
    vm: {
      assertCurrentBinding: vi.fn(async (_context, expected) => {
        if (JSON.stringify(expected) !== JSON.stringify(current))
          throw new EgressError('STALE_BINDING');
      }),
    },
    authority,
    transport: { read: upstream },
    revokeModel: async (b) => {
      revoked.push(b);
    },
    provisioner: {
      endpoint: async () => ({
        host: '127.0.0.1',
        port,
        guestOrigin: `http://127.0.0.1:${port}`,
      }),
      install: async (_b, a) => {
        access = a;
      },
      remove: async () => {},
    },
    ...extra,
  });
  let receipt = await gateway.prepare(binding, signal());
  cleanup.push(() => gateway.revoke(receipt, 'stop', signal()));
  return {
    gateway,
    upstream,
    authority,
    revoked,
    get access() {
      return access!;
    },
    get receipt() {
      return receipt;
    },
    async next() {
      current = { ...binding, instanceId: 'instance-b', leaseEpoch: 2 };
      receipt = await gateway.prepare(current, signal());
      return receipt;
    },
    async read(
      path = '/market/okx/candles?symbol=ETH-USDT&bar=4H&limit=10',
      init: RequestInit = {},
    ) {
      return fetch(access!.origin + path, {
        ...init,
        headers: {
          authorization: 'Bearer ' + access!.capability,
          ...init.headers,
        },
      });
    },
  };
}

describe('trusted VM HTTP egress (VM and identity owners are explicit fixtures)', () => {
  it('reads market data via the authenticated real HTTP entry and checks present authority twice', async () => {
    const f = await fixture();
    const response = await f.read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(candles);
    expect(f.upstream).toHaveBeenCalledTimes(1);
    expect(f.authority.allow).toHaveBeenCalledTimes(2);
    const [url] = f.upstream.mock.calls[0]! as unknown as [URL];
    expect(url.href).toBe(
      'https://www.okx.com/api/v5/market/candles?instId=ETH-USDT&bar=4H&limit=10',
    );
    expect(JSON.stringify(f.receipt)).not.toContain(f.access.capability);
  });
  it('rejects unauthenticated host callers and forged identity before upstream', async () => {
    const f = await fixture();
    for (const headers of [
      {},
      {
        authorization: 'Bearer wrong',
        'x-person-id': 'person-a',
        'x-vm-id': binding.vmId,
      },
    ]) {
      const r = await fetch(f.access.origin + '/market/okx/instruments', {
        headers,
      });
      expect(r.status).toBe(403);
      await r.body?.cancel();
    }
    expect(f.upstream).not.toHaveBeenCalled();
  });
  it.each([
    [
      '/market/okx/candles?symbol=ETH-USDT&symbol=BTC-USDT&bar=4H&limit=10',
      'GET',
    ],
    ['/market/okx/candles?symbol=ETH-USDT&bar=4H&limit=101', 'GET'],
    ['/market/okx/instruments?target=https://127.0.0.1', 'GET'],
    ['/api/v5/trade/order', 'GET'],
    ['/market/okx/instruments', 'POST'],
    [
      '/market/okx/candles?symbol=ETH-USDT&bar=4H&limit=10&approved=true',
      'GET',
    ],
  ])(
    'denies unregistered request %s %s without upstream side effects',
    async (path, method) => {
      const f = await fixture();
      const r = await f.read(path, { method });
      expect(r.status).toBe(403);
      await r.body?.cancel();
      expect(f.upstream).not.toHaveBeenCalled();
    },
  );
  it('rechecks revocation after an upstream read and returns no data', async () => {
    const f = await fixture();
    f.authority.allow
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new EgressError('DENIED');
      });
    const r = await f.read();
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('1000');
  });
  it('rotates epoch capability on the same port; delayed revoke cannot kill the new epoch', async () => {
    const f = await fixture();
    const old = f.receipt,
      oldAccess = f.access;
    const next = await f.next();
    expect(next.gatewayPorts).toEqual(old.gatewayPorts);
    await f.gateway.revoke(old, 'takeover', signal());
    await f.gateway.assertActive(next, signal());
    const denied = await fetch(oldAccess.origin + '/market/okx/instruments', {
      headers: { authorization: 'Bearer ' + oldAccess.capability },
    });
    expect(denied.status).toBe(403);
    await denied.body?.cancel();
    expect((await f.read()).status).toBe(200);
    expect(f.revoked).toEqual([binding]);
    await expect(f.gateway.prepare(binding, signal())).rejects.toThrow(
      'STALE_BINDING',
    );
  });
  it('aborts and drains in-flight upstream reads when revoking, including model drain', async () => {
    let began!: () => void;
    const started = new Promise<void>((r) => {
      began = r;
    });
    let ended = false;
    let modelDrained = false;
    const f = await fixture({
      transport: {
        read: async (_url, { signal }) => {
          began();
          await new Promise<void>((resolve) =>
            signal.addEventListener(
              'abort',
              () => {
                ended = true;
                resolve();
              },
              { once: true },
            ),
          );
          signal.throwIfAborted();
          return asJson(candles);
        },
      },
      revokeModel: async () => {
        modelDrained = true;
      },
    });
    const request = f.read().catch(() => null);
    await started;
    await f.gateway.revoke(f.receipt, 'stop', signal());
    await request;
    expect(ended).toBe(true);
    expect(modelDrained).toBe(true);
    await expect(f.gateway.assertActive(f.receipt, signal())).rejects.toThrow(
      'STALE_BINDING',
    );
  });
  it('retains cleanup failure as unknown and keeps admission closed', async () => {
    let fail = true;
    const f = await fixture({
      revokeModel: async () => {
        if (fail) throw Error('drain failed');
      },
    });
    await expect(f.gateway.revoke(f.receipt, 'stop', signal())).rejects.toThrow(
      'EGRESS_CLEANUP_INCOMPLETE',
    );
    await expect(f.gateway.assertActive(f.receipt, signal())).rejects.toThrow(
      'STALE_BINDING',
    );
    fail = false;
  });
});

describe('standard package metadata and byte integrity', () => {
  const body = Buffer.from('fixture package bytes');
  const integrity =
    'sha512-' + createHash('sha512').update(body).digest('base64');
  const options = {
    ...budgets,
    npmOrigin: 'https://registry.npmjs.org',
    pypiOrigin: 'https://pypi.org',
    pythonFilesOrigin: 'https://files.pythonhosted.org',
    maxArtifacts: 20,
  };
  it('rewrites npm metadata to same gateway and only serves checksum-matching artifacts', async () => {
    const routes = createPackageMirrorRoutes(options);
    const f = await fixture({
      policy: { routes },
      transport: {
        read: async (url) =>
          url.pathname.includes('/-/')
            ? { status: 200, contentType: 'application/octet-stream', body }
            : asJson({
                name: '@test/lib',
                versions: {
                  '1.0.0': {
                    name: '@test/lib',
                    version: '1.0.0',
                    dist: {
                      tarball:
                        'https://registry.npmjs.org/@test/lib/-/lib-1.0.0.tgz',
                      integrity,
                    },
                  },
                },
              }),
      },
    });
    const r = await f.read('/npm/%40test%2Flib');
    expect(r.status).toBe(200);
    const metadata = await r.json();
    const target = new URL(metadata.versions['1.0.0'].dist.tarball);
    expect(target.origin).toBe(f.access.origin);
    const artifact = await f.read(target.pathname);
    expect(Buffer.from(await artifact.arrayBuffer())).toEqual(body);
    expect(
      (await f.read('/packages/' + 'a'.repeat(64) + '/fake.tgz')).status,
    ).toBe(403);
  });
  it('does not admit an artifact URL from a malicious metadata origin', async () => {
    const f = await fixture({
      policy: { routes: createPackageMirrorRoutes(options) },
      transport: {
        read: async () =>
          asJson({
            name: 'lib',
            versions: {
              '1': {
                name: 'lib',
                version: '1',
                dist: { tarball: 'https://127.0.0.1/private.tgz', integrity },
              },
            },
          }),
      },
    });
    expect((await f.read('/npm/lib')).status).toBe(502);
  });
  it('serves pip simple HTML with hashes and Basic local capability, not upstream credentials', async () => {
    const sha = createHash('sha256').update(body).digest('hex');
    const f = await fixture({
      policy: { routes: createPackageMirrorRoutes(options) },
      transport: {
        read: async (url) =>
          url.hostname === 'files.pythonhosted.org'
            ? { status: 200, contentType: 'application/octet-stream', body }
            : asJson({
                info: { name: 'a_pkg' },
                releases: {
                  '1': [
                    {
                      filename: 'a_pkg-1-py3-none-any.whl',
                      url: 'https://files.pythonhosted.org/packages/a.whl',
                      digests: { sha256: sha },
                      requires_python: '>=3.8',
                      yanked: false,
                    },
                  ],
                },
              }),
      },
    });
    const r = await f.read('/python/simple/a-pkg/', {
      headers: {
        authorization:
          'Basic ' +
          Buffer.from('egress:' + f.access.capability).toString('base64'),
      },
    });
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain('#sha256=' + sha);
    expect(html).not.toContain('files.pythonhosted.org');
    expect(html).not.toContain(f.access.capability);
    const path = new URL(/href="([^"]+)/.exec(html)![1]!).pathname;
    expect((await f.read(path)).status).toBe(200);
  });
  it('denies nonconfigured package query and corrupt upstream bytes', async () => {
    const routes = createPackageMirrorRoutes(options);
    expect(() =>
      routes[0]!.target(
        new URLSearchParams('target=https://evil.invalid'),
        '/npm/lib',
      ),
    ).toThrow('DENIED');
    const metadata = routes[0]!.transform!(
      asJson({
        name: 'lib',
        versions: {
          '1': {
            name: 'lib',
            version: '1',
            dist: {
              tarball: 'https://registry.npmjs.org/lib/-/lib.tgz',
              integrity,
            },
          },
        },
      }),
      '/npm/lib',
      'http://gateway:1234',
    );
    const url = new URL(
      JSON.parse(Buffer.from(metadata.body).toString()).versions['1'].dist
        .tarball,
    );
    expect(() =>
      routes[2]!.transform!(
        {
          status: 200,
          contentType: 'application/octet-stream',
          body: Buffer.from('corrupt'),
        },
        url.pathname,
        url.origin,
      ),
    ).toThrow('INVALID_RESPONSE');
  });
});
