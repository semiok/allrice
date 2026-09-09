import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RuntimeLocalCommandSchema,
  LocalPreviewTargetSchema,
  localPreviewOrigin,
  type RuntimeLocalCommandResult,
  type LocalPreviewTarget,
} from '@allrice/contracts';
import { testImage, testSocket } from '../test/toolchain.js';
import { LocalCommandRunner } from './local-command-runner.js';
import { LocalServiceRunner } from './local-service-runner.js';
import { LocalPreviewRelay } from './local-preview-relay.js';

const source = `import http from 'node:http';
let writes=0;
http.createServer((q,s)=>{
 const chunks=[];q.on('data',b=>chunks.push(b));q.on('end',()=>{
  if(q.url==='/away'){s.writeHead(302,{location:'http://127.0.0.1:5432/'});s.end();return;}
  if(q.url==='/redirect'){s.writeHead(302,{location:'/'});s.end();return;}
  if(q.url==='/huge'){s.end('x'.repeat(1000001));return;}
  if(q.url==='/hang')return;
  if(q.method==='POST')writes++;
  if(q.url==='/'){s.setHeader('content-type','text/html');s.end('<!doctype html><h1>Real project preview</h1><script src="/app.js"></script><form method="post" action="/save"><button>Save once</button></form>');return;}
  if(q.url==='/app.js'){s.setHeader('content-type','application/javascript');s.end('document.body.dataset.loaded="real-container"');return;}
  s.setHeader('content-type','application/json');s.setHeader('set-cookie','unsafe=discarded');
  s.end(JSON.stringify({method:q.method,path:q.url,body:Buffer.concat(chunks).toString(),headers:q.headers,writes}));
 });
}).listen(3100,'127.0.0.1');`;
const hash = (s: string) =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;
const suite = process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET
  ? describe.sequential
  : describe.skip;
suite('P23 real service HTTP relay in dedicated VM (no host port)', () => {
  let root: string,
    runner: LocalCommandRunner,
    relay: LocalPreviewRelay,
    target: LocalPreviewTarget;
  let lifecycle: Promise<RuntimeLocalCommandResult>,
    stop = false,
    authority = true;
  const current = async () => {
    if (!authority) throw Error('synthetic expired/revoked lease');
    return { expiresAt: new Date(Date.now() + 5000).toISOString() };
  };
  const get = (path: string) =>
    relay.fetch(
      target,
      {
        url: localPreviewOrigin(target.endpointId) + path,
        method: 'GET',
        headers: {},
      },
      { assertCurrent: current },
    );
  beforeAll(async () => {
    if (process.env.ALLRICE_LOCAL_DOCKER_TEST_SOCKET !== testSocket)
      throw Error('dedicated VM required');
    runner = new LocalCommandRunner({
      socketPath: testSocket,
      imageDigest: testImage,
    });
    await runner.preflight();
    relay = new LocalPreviewRelay(runner);
    root = await mkdtemp(join(tmpdir(), 'allrice-p23-real-relay-'));
    await writeFile(join(root, 'service.mjs'), source);
    const command = RuntimeLocalCommandSchema.parse({
      capability: 'local.process.execute',
      arguments: {
        executable: '/usr/local/bin/node',
        args: ['service.mjs'],
        path: '.',
        files: [{ path: 'service.mjs', sha256: hash(source) }],
        imageDigest: testImage,
        isolation: 'local-vm-container-v1',
        network: 'none',
        limits: {
          timeoutMs: 10000,
          outputBytes: 8192,
          memoryMiB: 128,
          cpuMillis: 500,
          pids: 32,
        },
        background: {
          durationMs: 180000,
          readiness: { kind: 'http', port: 3100, path: '/', timeoutMs: 10000 },
          stdin: {
            mode: 'none',
            maxRequests: 1,
            maxBytes: 100,
            requestTimeoutMs: 1000,
          },
        },
      },
    });
    const attemptId = randomUUID(),
      processId = randomUUID(),
      runId = randomUUID();
    const hardDeadlineAt = new Date(Date.now() + 180000).toISOString();
    let ready!: () => void;
    const signal = new Promise<void>((resolve) => {
      ready = resolve;
    });
    lifecycle = new LocalServiceRunner(runner).execute(root, command, {
      processId,
      attemptId,
      hardDeadlineAt,
      maintainLease: async () => ({
        leaseExpiresAt: new Date(Date.now() + 10000).toISOString(),
        stopRequested: stop,
        inputs: [],
      }),
      prepareInput: async () => {
        throw Error('no stdin');
      },
      onEvent: async (event) => {
        if (event.type === 'starting')
          target = LocalPreviewTargetSchema.parse({
            version: 1,
            endpointId: randomUUID(),
            scope: {
              organizationId: randomUUID(),
              workspaceId: randomUUID(),
              projectId: null,
            },
            ownerId: randomUUID(),
            deviceId: randomUUID(),
            runId,
            rootRunId: runId,
            browserWorkspaceId: randomUUID(),
            browserProfileId: randomUUID(),
            browserGrantId: randomUUID(),
            processId,
            attemptId,
            generation: 1,
            fence: 1,
            processInputDigest: hash(JSON.stringify(command)),
            folderGrantId: randomUUID(),
            folderGrantVersion: 1,
            containerId: event.containerId,
            imageDigest: testImage,
            port: 3100,
            hardDeadlineAt,
          });
        if (event.type === 'ready') ready();
      },
    });
    await Promise.race([
      signal,
      lifecycle.then((value) => {
        throw Error('service exited before preview readiness: ' + value.reason);
      }),
    ]);
  }, 30000);
  afterAll(async () => {
    stop = true;
    if (lifecycle) {
      const result = await lifecycle;
      await runner.cleanup(target.attemptId, result.containerId);
    }
    if (root) {
      expect(await readFile(join(root, 'service.mjs'), 'utf8')).toBe(source);
      await rm(root, { recursive: true, force: true });
    }
  }, 20000);
  it('serves actual HTML and project asset bytes without publishing a host port', async () => {
    const html = await get('/');
    expect(html.status).toBe(200);
    expect(html.body.toString()).toContain('Real project preview');
    const asset = await get('/app.js');
    expect(asset.body.toString()).toContain('real-container');
    const container = await runner.api.json<{
      HostConfig: { NetworkMode: string; PortBindings: unknown };
    }>('GET', `/containers/${target.containerId}/json`);
    expect(container.HostConfig.NetworkMode).toBe('none');
    expect(container.HostConfig.PortBindings ?? {}).toEqual({});
  }, 20000);
  it('delivers a single exact approved request and strips cookies and authorization', async () => {
    const response = await relay.fetch(
      target,
      {
        url: localPreviewOrigin(target.endpointId) + '/save?synthetic=1',
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          cookie: 'private-cookie=synthetic',
          authorization: 'Bearer synthetic',
          origin: localPreviewOrigin(target.endpointId),
        },
        body: Buffer.from('synthetic-save'),
      },
      { assertCurrent: current },
    );
    const actual = JSON.parse(response.body.toString());
    expect(actual).toMatchObject({
      path: '/save?synthetic=1',
      method: 'POST',
      body: 'synthetic-save',
      writes: 1,
    });
    expect(actual.headers.cookie).toBeUndefined();
    expect(actual.headers.authorization).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(actual.headers.host).toBe(
      new URL(localPreviewOrigin(target.endpointId)).host,
    );
  }, 15000);
  it('keeps same-origin redirects but rejects external and loopback redirects', async () => {
    expect((await get('/redirect')).headers.location).toBe(
      localPreviewOrigin(target.endpointId) + '/',
    );
    await expect(get('/away')).rejects.toMatchObject({
      code: 'LOCAL_PREVIEW_NETWORK_DENIED',
    });
  }, 15000);
  it('rejects arbitrary port/host and foreign container identity before HTTP', async () => {
    await expect(
      relay.fetch(
        target,
        { url: 'http://127.0.0.1:5432/', method: 'GET', headers: {} },
        { assertCurrent: current },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_PREVIEW_REQUEST_INVALID' });
    await expect(
      relay.fetch(
        { ...target, processId: randomUUID() },
        {
          url: localPreviewOrigin(target.endpointId) + '/',
          method: 'GET',
          headers: {},
        },
        { assertCurrent: current },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_PREVIEW_TARGET_DENIED' });
  });
  it('rejects expired authority without replaying an earlier write', async () => {
    authority = false;
    try {
      await expect(get('/status')).rejects.toThrow();
    } finally {
      authority = true;
    }
    expect(JSON.parse((await get('/status')).body.toString()).writes).toBe(1);
  }, 15000);
  it('enforces body/output bounds and an absolute response deadline', async () => {
    await expect(
      relay.fetch(
        target,
        {
          url: localPreviewOrigin(target.endpointId) + '/',
          method: 'POST',
          headers: {},
          body: Buffer.alloc(1000001),
        },
        { assertCurrent: current },
      ),
    ).rejects.toMatchObject({ code: 'LOCAL_PREVIEW_REQUEST_INVALID' });
    await expect(get('/huge')).rejects.toThrow();
    const started = Date.now();
    await expect(get('/hang')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20000);
  it('denies access immediately after the actual service stops', async () => {
    stop = true;
    const result = await lifecycle;
    expect(result.stopped).toBe(true);
    await expect(get('/')).rejects.toMatchObject({
      code: 'LOCAL_PREVIEW_TARGET_DENIED',
    });
  }, 20000);
});
