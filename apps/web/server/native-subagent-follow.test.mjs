import { once } from 'node:events';
import { URL } from 'node:url';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { AllRiceHttpServer } from '../server.mjs';
import { createNativeSubagentFollowGateway } from './native-subagent-follow.mjs';
import { createWebRuntimeClose } from './close-runtime.mjs';
import { createProjectPreviewGateway } from './project-preview.mjs';
const cleanups = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture({
  hold = false,
  status = 200,
  type = 'text/event-stream',
} = {}) {
  const server = new AllRiceHttpServer(),
    reads = [],
    clients = [],
    responses = [];
  let closed = 0;
  const nextUpgrade = vi.fn((_req, socket) => socket.destroy());
  server.on('upgrade', nextUpgrade);
  server.on('request', (req, res) => {
    reads.push({ url: req.url, headers: req.headers });
    responses.push(res);
    res.once('close', () => {
      closed++;
    });
    if (!hold)
      res
        .writeHead(status, { 'content-type': type })
        .write('data: {"type":"clear","reason":"resync"}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  server.nativeFollowGateway = createNativeSubagentFollowGateway({
    port: server.address().port,
  });
  cleanups.push(async () => {
    for (const peer of clients) peer.terminate();
    await server.nativeFollowGateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const connect = ({
    query = '',
    headers = {},
    path = '/api/v1/sessions/parent/subagents',
  } = {}) => {
    const peer = new WebSocket(
      origin.replace('http:', 'ws:') +
        path +
        '?workspaceId=workspace&organizationId=org&follow=true' +
        query,
      { headers: { origin, cookie: 'allrice_session=opaque', ...headers } },
    );
    peer.on('error', () => {});
    clients.push(peer);
    return peer;
  };
  return {
    server,
    origin,
    reads,
    responses,
    connect,
    nextUpgrade,
    closed: () => closed,
  };
}
it('intercepts Next upgrade, forwards only the fixed authorized scope, and cancels upstream on browser close', async () => {
  const f = await fixture();
  const peer = f.connect({
    query: '&childId=child%2Fopaque&liveOnly=true',
    headers: {
      authorization: 'must-not-forward',
      'x-internal-key': 'must-not-forward',
    },
  });
  const [frame, binary] = await once(peer, 'message');
  expect(binary).toBe(true);
  expect(frame.toString()).toContain('"reason":"resync"');
  expect(f.nextUpgrade).not.toHaveBeenCalled();
  expect(f.reads).toHaveLength(1);
  const request = f.reads[0],
    target = new URL(request.url, f.origin);
  expect(target.pathname).toBe('/api/v1/sessions/parent/subagents');
  expect(Object.fromEntries(target.searchParams)).toEqual({
    workspaceId: 'workspace',
    follow: 'true',
    childId: 'child/opaque',
    liveOnly: 'true',
  });
  expect(request.headers.cookie).toBe('allrice_session=opaque');
  expect(request.headers['x-allrice-organization-id']).toBe('org');
  expect(request.headers['x-allrice-workspace-id']).toBe('workspace');
  expect(request.headers.authorization).toBeUndefined();
  expect(request.headers['x-internal-key']).toBeUndefined();
  peer.close(1000);
  await once(peer, 'close');
  await vi.waitFor(() => expect(f.closed()).toBe(1));
});
it('keeps the same path on a preview host owned by preview, and follows native on the ordinary host', async () => {
  const f = await fixture(),
    id = '11111111-1111-4111-8111-111111111111',
    host = `rice-preview-${id}.preview.localhost`,
    access = vi.fn(async () => {
      throw Error('preview authorization fixture');
    });
  f.server.previewGateway = createProjectPreviewGateway({
    suffix: 'preview.localhost',
    mainOrigin: f.origin,
    secure: false,
    resolveAccess: access,
    transport: {},
  });
  cleanups.push(() => f.server.previewGateway.close());
  const preview = f.connect({
    headers: {
      host,
      origin: `http://${host}`,
      cookie: 'allrice_preview_test=preview-token',
    },
  });
  const [, response] = await once(preview, 'unexpected-response');
  expect(response.statusCode).toBe(403);
  expect(access).toHaveBeenCalledWith(id, 'preview-token');
  expect(f.reads).toHaveLength(0);
  const ordinary = f.connect();
  expect((await once(ordinary, 'message'))[0].toString()).toContain('resync');
  expect(f.reads).toHaveLength(1);
  expect(f.nextUpgrade).not.toHaveBeenCalled();
});
it.each([
  { headers: { origin: 'https://evil.example' } },
  { headers: { 'sec-fetch-site': 'cross-site' } },
  { query: '&url=http://169.254.169.254/' },
  { query: '&workspaceId=other' },
])('refuses unsafe upgrade before any loopback read: %j', async (input) => {
  const f = await fixture(),
    peer = f.connect(input);
  const [, response] = await once(peer, 'unexpected-response');
  expect(response.statusCode).toBe(403);
  expect(f.reads).toHaveLength(0);
});
it.each([
  [401, 'application/json'],
  [403, 'application/json'],
  [200, 'application/json'],
])(
  'never upgrades rejected authorization or a non-follow response (%i/%s)',
  async (status, type) => {
    const f = await fixture({ status, type }),
      peer = f.connect();
    const opened = vi.fn();
    peer.on('open', opened);
    const [, response] = await once(peer, 'unexpected-response');
    expect(response.statusCode).toBe(status === 200 ? 503 : status);
    expect(opened).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.closed()).toBe(1));
  },
);
it('ends normally when the authorized upstream ends, and refuses browser application messages', async () => {
  const f = await fixture(),
    first = f.connect();
  await once(first, 'message');
  const closed = once(first, 'close');
  f.responses[0].end();
  expect((await closed)[0]).toBe(1000);
  const second = f.connect();
  await once(second, 'message');
  second.send('x');
  await once(second, 'close');
  await vi.waitFor(() => expect(f.closed()).toBe(2));
});
it.each([true, false])(
  'Web shutdown cancels follow ownership (authorization pending=%s)',
  async (hold) => {
    const f = await fixture({ hold });
    const peer = f.connect();
    if (!hold) await once(peer, 'message');
    await vi.waitFor(() => expect(f.reads).toHaveLength(1));
    const closed = once(peer, 'close').catch(() => undefined);
    const close = createWebRuntimeClose({
      server: f.server,
      lifecycle: { waitForCurrentRoots: async () => {} },
      app: { close: async () => {} },
      closeDatabase: async () => {},
    });
    await close();
    await closed;
    await vi.waitFor(() => expect(f.closed()).toBe(1));
  },
);
