import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { RequestOptions } from 'node:https';
import { createPublicHttpsTransport } from './transport.js';

const io = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
  interfaces: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: io.lookup }));
vi.mock('node:https', () => ({ request: io.request }));
vi.mock('node:os', () => ({ networkInterfaces: io.interfaces }));

beforeEach(() => {
  vi.resetAllMocks();
  io.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  io.interfaces.mockReturnValue({});
});
function read(
  url = 'https://registry.example/pkg',
  maxBytes = 16,
  signal = new AbortController().signal,
) {
  return createPublicHttpsTransport().read(new URL(url), { maxBytes, signal });
}
function reply(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  io.request.mockImplementation((_options, receive) => {
    const req = new EventEmitter();
    return Object.assign(req, {
      end() {
        const response = Object.assign(new PassThrough(), {
          statusCode: status,
          headers,
        });
        receive(response);
        response.end(Buffer.from(body));
      },
    });
  });
}
it.each([
  'http://registry.example/pkg',
  'https://127.0.0.1/pkg',
  'https://user:secret@registry.example/pkg',
  'https://registry.example:8443/pkg',
])('rejects unsafe target before DNS: %s', async (target) => {
  await expect(read(target)).rejects.toMatchObject({ code: 'DENIED' });
  expect(io.lookup).not.toHaveBeenCalled();
  expect(io.request).not.toHaveBeenCalled();
});
it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1'])(
  'rejects mixed DNS containing %s before connecting',
  async (address) => {
    io.lookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address, family: 4 },
    ]);
    await expect(read()).rejects.toMatchObject({ code: 'DENIED' });
    expect(io.request).not.toHaveBeenCalled();
  },
);
it('rejects the host public interface address too', async () => {
  io.interfaces.mockReturnValue({ eth0: [{ address: '8.8.8.8' }] });
  await expect(read()).rejects.toMatchObject({ code: 'DENIED' });
  expect(io.request).not.toHaveBeenCalled();
});
it('pins the validated address without another resolver or proxy and preserves TLS identity', async () => {
  reply(200, 'ok');
  expect(
    Buffer.from(
      (await read('https://registry.example/pkg?q=1')).body,
    ).toString(),
  ).toBe('ok');
  const options = io.request.mock.calls[0]![0] as RequestOptions;
  expect(options).toMatchObject({
    hostname: 'registry.example',
    servername: 'registry.example',
    family: 4,
    agent: false,
    method: 'GET',
    path: '/pkg?q=1',
  });
  const pinned = vi.fn();
  options.lookup!('registry.example', {}, pinned);
  expect(pinned).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  expect(io.lookup).toHaveBeenCalledTimes(1);
  expect(options.headers).not.toHaveProperty('authorization');
});
it.each([
  [302, {}],
  [200, { 'content-encoding': 'gzip' }],
])(
  'rejects redirects and compressed responses (%s)',
  async (status, headers) => {
    reply(status, 'body', headers);
    await expect(read()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(io.request).toHaveBeenCalledTimes(1);
  },
);
it('enforces the byte budget on the response stream', async () => {
  reply(200, 'too large');
  await expect(read(undefined, 2)).rejects.toMatchObject({
    code: 'LIMIT_EXCEEDED',
  });
});
it('does not start a socket after authority aborts during DNS', async () => {
  const controller = new AbortController();
  io.lookup.mockImplementation(async () => {
    controller.abort();
    return [{ address: '8.8.8.8', family: 4 }];
  });
  await expect(read(undefined, 16, controller.signal)).rejects.toThrow();
  expect(io.request).not.toHaveBeenCalled();
});
