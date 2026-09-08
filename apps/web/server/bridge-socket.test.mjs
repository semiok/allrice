import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { URL } from 'node:url';

import {
  bridgeSocketPath,
  bridgeSocketProtocol,
  bridgeSocketMaximumFrameBytes,
} from '@allrice/contracts';
import { createBridgeConnectionAuthority } from '@allrice/database';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import WebSocket from 'ws';

import { AllRiceHttpServer } from '../server.mjs';
import { createRuntimeBridgeHttpHandler } from '../lib/bridge/operation-http.ts';
import { bridgeDeviceStatus } from '../../../packages/database/src/bridge.ts';
import { createGovernedBridgeOperationLedger } from '../../../packages/database/src/runtime-governed-bridge.ts';
import {
  createBridgeLoopbackDispatch,
  createBridgeSocketGateway,
} from './bridge-socket.mjs';

const postgres = createRequire(
  new URL('../../../packages/database/package.json', import.meta.url),
)('postgres');
const suite =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
const schema = `bridge_wss_test_${randomUUID().replaceAll('-', '')}`;
let admin, database, isolatedDatabaseUrl;
const cleanups = [];
vi.mock('../../../packages/database/src/core/client.ts', async (original) => ({
  ...(await original()),
  getDatabase: () => database,
}));
const waitUntil = async (predicate, limit = 5000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > limit)
      throw new Error('Expected socket event did not arrive');
    await delay(5);
  }
};

async function device() {
  const organization = randomUUID(),
    workspace = randomUUID(),
    user = randomUUID(),
    id = randomUUID();
  const token = `synthetic-p11-${randomUUID()}`;
  await database`insert into allrice_users(id,email,display_name,password_hash) values(${user},${`${user}@example.test`},'P11','not-a-login')`;
  await database`insert into allrice_organizations(id,slug,name) values(${organization},${organization},'P11')`;
  await database`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspace},${organization},'test','P11')`;
  await database`insert into allrice_bridge_devices(id,organization_id,workspace_id,owner_id,name,platform,protocol_version,capabilities,token_hash,last_seen_at)
    values(${id},${organization},${workspace},${user},'P11 synthetic','macos-x64',2,array['local.fs.read'],${createHash('sha256').update(token).digest('hex')},clock_timestamp())`;
  return { id, token };
}

async function gateway(options = {}) {
  const server = new AllRiceHttpServer();
  const actualHandler = createRuntimeBridgeHttpHandler({
    enabled: () => true,
    authenticate: bridgeDeviceStatus,
    ledgerForDevice: async (d) =>
      createGovernedBridgeOperationLedger(d, { database }),
  });
  let operations = 0,
    foreignUpgrades = 0;
  server.on('request', (req, res) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const match = url.pathname.match(
        /^\/api\/v1\/bridge\/device\/operations\/(next|([0-9a-f-]+)\/(start|heartbeat|output|receipts))$/,
      );
      if (!match) {
        res.writeHead(404);
        res.end();
        return;
      }
      operations++;
      const request = new globalThis.Request(url, {
        method: 'POST',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const response = await actualHandler(
        request,
        match[1] === 'next' ? 'next' : match[3],
        match[2],
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    })().catch(() => {
      res.writeHead(500);
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const authority =
    options.authority ??
    createBridgeConnectionAuthority(database, { leaseMs: 2000 });
  server.bridgeGateway = await createBridgeSocketGateway({
    authority,
    enabled: options.enabled ?? (() => true),
    heartbeatMs: options.heartbeatMs ?? 100,
    dispatch: options.dispatch ?? createBridgeLoopbackDispatch(port),
    maximumConnections: options.maximumConnections ?? 256,
  });
  // Reproduce Next adding its own listener after requests: Bridge upgrades must not leak to it.
  server.on('upgrade', (_req, socket) => {
    foreignUpgrades++;
    socket.destroy();
  });
  cleanups.push(async () => {
    await server.bridgeGateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    authority,
    origin: `http://127.0.0.1:${port}`,
    url: `ws://127.0.0.1:${port}${bridgeSocketPath}`,
    operations: () => operations,
    foreignUpgrades: () => foreignUpgrades,
  };
}

async function connect(g, token, host) {
  const ws = new WebSocket(g.url, bridgeSocketProtocol, {
    headers: { authorization: `Bearer ${token}`, ...(host ? { host } : {}) },
    perMessageDeflate: false,
  });
  const messages = [];
  let closed = null;
  ws.on('message', (data) => messages.push(JSON.parse(data.toString('utf8'))));
  ws.on('close', (code) => {
    closed = code;
  });
  ws.on('error', () => undefined);
  cleanups.push(async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
      await once(ws, 'close');
    }
  });
  await waitUntil(() => messages.some((m) => m.type === 'welcome'));
  return {
    ws,
    messages,
    welcome: messages.find((m) => m.type === 'welcome'),
    closed: () => closed,
    async call(patch = {}) {
      const id = randomUUID();
      ws.send(
        JSON.stringify({
          version: 1,
          type: 'request',
          id,
          action: 'operation.next',
          body: {},
          ...patch,
        }),
      );
      await waitUntil(() => messages.some((m) => m.id === id));
      return messages.find((m) => m.id === id);
    },
  };
}

async function rejected(
  g,
  { token, url = g.url, protocol = bridgeSocketProtocol, origin } = {},
) {
  const ws = new WebSocket(url, protocol, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
  });
  ws.on('error', () => undefined);
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_request, response) => {
      response.resume();
      ws.terminate();
      resolve(response.statusCode);
    });
    ws.on('open', () => {
      ws.terminate();
      reject(new Error('Unexpectedly accepted socket'));
    });
  });
}

suite(
  'P11 real PostgreSQL + two WebSocket gateway instances + existing HTTP authority',
  () => {
    beforeAll(async () => {
      const source = process.env.ALLRICE_TEST_DATABASE_URL;
      if (!source) throw new Error('Explicit isolated test database required');
      const base = new URL(source);
      if (
        !['localhost', '127.0.0.1'].includes(base.hostname) ||
        !/^\/allrice_(b2|test)$/.test(base.pathname)
      )
        throw new Error('REFUSE_NON_TEST_DATABASE');
      base.search = '';
      admin = postgres(base.toString(), { max: 1, onnotice: () => {} });
      await admin.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(20260907,1)`;
        await sql`create extension if not exists vector with schema public`;
        await sql`create extension if not exists pg_trgm with schema public`;
      });
      await admin.unsafe(`create schema ${schema}`);
      base.searchParams.set('options', `-csearch_path=${schema},public`);
      isolatedDatabaseUrl = base.toString();
      database = postgres(base.toString(), { max: 12, onnotice: () => {} });
      const directory = new URL(
        '../../../packages/database/migrations/',
        import.meta.url,
      );
      for (const name of (await readdir(directory))
        .filter((name) => name.endsWith('.sql'))
        .sort())
        await database.unsafe(await readFile(new URL(name, directory), 'utf8'));
    }, 120_000);
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });
    afterAll(async () => {
      await database?.end({ timeout: 5 });
      if (admin && /^bridge_wss_test_[a-f0-9]{32}$/.test(schema))
        await admin.unsafe(`drop schema ${schema} cascade`);
      await admin?.end({ timeout: 5 });
    });

    it('feature flag off never registers a connection; legacy HTTP still works', async () => {
      const d = await device(),
        g = await gateway({ enabled: () => false });
      expect(await rejected(g, { token: d.token })).toBe(404);
      expect(
        (
          await database`select device_id from allrice_bridge_connections where device_id=${d.id}`
        ).length,
      ).toBe(0);
      const response = await globalThis.fetch(
        `${g.origin}/api/v1/bridge/device/operations/next`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${d.token}`,
            'content-type': 'application/json',
          },
          body: '{}',
        },
      );
      expect(response.status).toBe(200);
    });

    it('rejects anonymous, wrong token, query credentials, browser Origin and unsupported protocol before registering', async () => {
      const d = await device(),
        g = await gateway();
      expect(await rejected(g)).toBe(401);
      expect(await rejected(g, { token: 'wrong' })).toBe(401);
      expect(
        await rejected(g, { token: d.token, url: `${g.url}?token=${d.token}` }),
      ).toBe(400);
      expect(
        await rejected(g, {
          token: d.token,
          origin: 'https://malicious.example',
        }),
      ).toBe(400);
      expect(
        await rejected(g, { token: d.token, protocol: 'allrice.bridge.v2' }),
      ).toBe(400);
      expect(
        (
          await database`select device_id from allrice_bridge_connections where device_id=${d.id}`
        ).length,
      ).toBe(0);
    });

    it('negotiates bounded transport and reuses authenticated HTTP + actual governed PG ledger', async () => {
      const d = await device(),
        g = await gateway(),
        c = await connect(g, d.token);
      expect(c.welcome).toMatchObject({
        version: 1,
        deviceId: d.id,
        epoch: '1',
      });
      expect(JSON.stringify(c.welcome)).not.toContain(d.token);
      expect(await c.call()).toMatchObject({
        status: 200,
        body: { dispatch: null },
      });
      expect(
        await c.call({
          action: 'operation.output',
          operationId: randomUUID(),
          body: {},
        }),
      ).toMatchObject({ status: 404 });
      expect(g.operations()).toBe(2);
      expect(g.foreignUpgrades()).toBe(0);
    });

    it('replaces across instances and late close cannot revoke the newer connection', async () => {
      const d = await device(),
        first = await gateway(),
        second = await gateway();
      const old = await connect(first, d.token),
        newer = await connect(second, d.token);
      expect(newer.welcome.epoch).toBe('2');
      await waitUntil(() => old.closed() !== null);
      expect(old.closed()).toBe(4009);
      await delay(30);
      expect(await newer.call()).toMatchObject({ status: 200 });
      const [row] =
        await database`select connection_id from allrice_bridge_connections where device_id=${d.id} and expires_at>clock_timestamp()`;
      expect(row.connection_id).toBe(newer.welcome.connectionId);
    });

    it('missed NOTIFY still rejects old owner at the next frame/heartbeat', async () => {
      const d = await device();
      const authority = createBridgeConnectionAuthority(database, {
        leaseMs: 2000,
      });
      const oldGateway = await gateway({
        authority: { ...authority, subscribe: async () => async () => {} },
      });
      const old = await connect(oldGateway, d.token);
      const newer = await connect(await gateway(), d.token);
      await waitUntil(() => old.closed() !== null);
      expect(await newer.call()).toMatchObject({ status: 200 });
    });

    it('device revocation closes only that tenant connection and cannot register again', async () => {
      const one = await device(),
        two = await device(),
        g = await gateway();
      const first = await connect(g, one.token),
        other = await connect(g, two.token);
      await database`update allrice_bridge_devices set revoked_at=clock_timestamp() where id=${one.id}`;
      await waitUntil(() => first.closed() !== null);
      expect(await rejected(g, { token: one.token })).toBe(401);
      expect(await other.call()).toMatchObject({ status: 200 });
    });

    it('invalid routing frame and binary frames do not reach operation authority', async () => {
      const d = await device(),
        g = await gateway();
      const c = await connect(g, d.token);
      c.ws.send(
        JSON.stringify({
          version: 1,
          type: 'request',
          id: randomUUID(),
          action: 'proxy',
          url: 'https://malicious.example',
          body: {},
        }),
      );
      await waitUntil(() => c.closed() !== null);
      const second = await connect(g, d.token);
      second.ws.send(Buffer.from('binary'));
      await waitUntil(() => second.closed() !== null);
      expect(g.operations()).toBe(0);
    });

    it('oversized frame is rejected at the WebSocket receiver before JSON parsing', async () => {
      const d = await device(),
        g = await gateway(),
        c = await connect(g, d.token);
      c.ws.send('x'.repeat(bridgeSocketMaximumFrameBytes + 1));
      await waitUntil(() => c.closed() !== null);
      expect(c.closed()).toBe(1009);
      expect(g.operations()).toBe(0);
    });

    it('queued request flood has finite backpressure and never dispatches arbitrary extra operations', async () => {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let count = 0;
      const d = await device(),
        g = await gateway({
          dispatch: async () => {
            count++;
            await gate;
            return { status: 200, body: {} };
          },
        }),
        c = await connect(g, d.token);
      for (let i = 0; i < 12; i++)
        c.ws.send(
          JSON.stringify({
            version: 1,
            type: 'request',
            id: randomUUID(),
            action: 'operation.next',
            body: {},
          }),
        );
      await waitUntil(() => c.closed() !== null);
      release();
      expect(c.closed()).toBe(4013);
      expect(count).toBeLessThanOrEqual(1);
    });

    it('unavailable database is fail-closed and a lost operation response is never retried by the gateway', async () => {
      const d = await device();
      let calls = 0;
      const g = await gateway({
        dispatch: async () => {
          calls++;
          throw new Error('Synthetic lost response after commit');
        },
      });
      const c = await connect(g, d.token);
      c.ws.send(
        JSON.stringify({
          version: 1,
          type: 'request',
          id: randomUUID(),
          action: 'operation.start',
          operationId: randomUUID(),
          body: {},
        }),
      );
      await waitUntil(() => c.closed() !== null);
      expect(calls).toBe(1);
      expect(c.closed()).toBe(4011);
      const real = createBridgeConnectionAuthority(database, { leaseMs: 2000 });
      let unavailable = false;
      const dbGateway = await gateway({
        authority: {
          ...real,
          current: (...args) => {
            if (unavailable) throw new Error('Synthetic database outage');
            return real.current(...args);
          },
        },
      });
      const other = await connect(dbGateway, d.token);
      unavailable = true;
      await waitUntil(() => other.closed() !== null);
      expect(other.closed()).toBe(4009);
    });

    it('a real paused reader cannot accumulate unbounded output buffers', async () => {
      const d = await device();
      let responses = 0;
      const g = await gateway({
        dispatch: async () => {
          responses++;
          return { status: 200, body: { sample: 'x'.repeat(700_000) } };
        },
      });
      const c = await connect(g, d.token);
      // Test-only access to the real TCP stream models a consumer that stops reading.
      c.ws._socket.pause();
      try {
        for (let i = 0; i < 30; i++) {
          if (c.ws.readyState !== WebSocket.OPEN) break;
          c.ws.send(
            JSON.stringify({
              version: 1,
              type: 'request',
              id: randomUUID(),
              action: 'operation.next',
              body: {},
            }),
          );
          await delay(20);
        }
      } finally {
        c.ws._socket.resume();
      }
      await waitUntil(() => c.closed() !== null);
      expect(c.closed()).toBe(4013);
      expect(responses).toBeLessThan(30);
    });

    it('concurrent registrations are serialized to one owner and an expired lease cannot renew', async () => {
      const d = await device();
      const one = createBridgeConnectionAuthority(database, { leaseMs: 2000 });
      const two = createBridgeConnectionAuthority(database, { leaseMs: 2000 });
      const [a, b] = await Promise.all([
        one.register(d.token),
        two.register(d.token),
      ]);
      expect([a.epoch, b.epoch].sort()).toEqual(['1', '2']);
      expect(
        (await Promise.all([one.current(a), two.current(b)])).filter(Boolean)
          .length,
      ).toBe(1);
      await database`update allrice_bridge_connections set expires_at=clock_timestamp()-interval '1 second' where device_id=${d.id}`;
      expect(await one.current(a, true)).toBe(false);
      expect(await two.current(b, true)).toBe(false);
    });

    it('database work notifications are wake hints without command bodies or cross-tenant broadcast', async () => {
      const one = await device(),
        two = await device(),
        g = await gateway();
      const a = await connect(g, one.token),
        b = await connect(g, two.token);
      await database`select pg_notify('allrice_bridge_commands',${one.id})`;
      await waitUntil(() => a.messages.some((m) => m.type === 'wakeup'));
      expect(a.messages.find((m) => m.type === 'wakeup')).toEqual({
        version: 1,
        type: 'wakeup',
      });
      expect(b.messages.some((m) => m.type === 'wakeup')).toBe(false);
    });

    it('a client that does not pong loses its transport lease', async () => {
      const d = await device(),
        g = await gateway();
      const ws = new WebSocket(g.url, bridgeSocketProtocol, {
        autoPong: false,
        headers: { authorization: `Bearer ${d.token}` },
      });
      ws.on('error', () => undefined);
      const closed = once(ws, 'close');
      await once(ws, 'open');
      const [code] = await closed;
      expect(code).toBe(4009);
    });

    it.runIf(process.env.ALLRICE_P11_NEXT_BUILD === '1')(
      'built Next wrapper preserves portal auth, HTTP and Bridge upgrade on the same port',
      async () => {
        const temporary = new AllRiceHttpServer();
        temporary.listen(0, '127.0.0.1');
        await once(temporary, 'listening');
        const port = temporary.address().port;
        await new Promise((resolve) => temporary.close(resolve));
        const child = spawn(
          process.execPath,
          [
            new URL('../server.mjs', import.meta.url).pathname,
            '--hostname',
            '127.0.0.1',
            '--port',
            String(port),
          ],
          {
            env: {
              NODE_ENV: 'production',
              ALLRICE_ENV: 'development',
              DATABASE_URL: isolatedDatabaseUrl,
              ALLRICE_BRIDGE_WSS_ENABLED: '1',
              ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED: '1',
              ALLRICE_PORTAL_AUTH_ENABLED: '1',
              ALLRICE_PORTAL_SESSION_SECRET:
                'synthetic-test-secret-never-a-real-credential',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (data) => {
          output = (output + data).slice(-4000);
        });
        child.stderr.on('data', (data) => {
          output = (output + data).slice(-4000);
        });
        cleanups.push(async () => {
          if (child.exitCode === null) {
            child.kill('SIGTERM');
            await once(child, 'exit');
          }
        });
        await waitUntil(
          () => output.includes('HTTP ready') || child.exitCode !== null,
          30_000,
        );
        expect(child.exitCode, output).toBeNull();
        const status = await new Promise((resolve, reject) => {
          const req = httpRequest(
            {
              hostname: '127.0.0.1',
              port,
              path: '/api/health/live',
              headers: { host: 'allrice-dsh.bplabs.xyz' },
            },
            (response) => {
              response.resume();
              response.on('end', () => resolve(response.statusCode));
            },
          );
          req.on('error', reject);
          req.end();
        });
        expect(status).toBe(200);
        const d = await device();
        const c = await connect(
          { url: `ws://127.0.0.1:${port}${bridgeSocketPath}` },
          d.token,
          'allrice-dsh.bplabs.xyz',
        );
        expect(await c.call()).toMatchObject({
          status: 200,
          body: { dispatch: null },
        });
      },
      60_000,
    );
  },
);
