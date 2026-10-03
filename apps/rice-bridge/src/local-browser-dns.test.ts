import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localBrowserPublicAddress } from './local-browser-network.js';
import { resolveLocalBrowserPublicAddress } from './local-browser-dns.js';

const ports = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: ports.lookup }));
vi.mock('node:https', () => ({ get: ports.get }));
const answer = (address: string) => ({ address, family: 4 });
const query = () =>
  resolveLocalBrowserPublicAddress('example.com', localBrowserPublicAddress);
const response = () => ({
  Status: 0,
  TC: false,
  Question: [{ name: 'example.com.', type: 1 }],
  Answer: [{ name: 'example.com.', type: 1, data: '104.20.23.154' }],
});
function reply(body: unknown, status = 200, raw?: string) {
  ports.get.mockImplementation((_options, callback) => {
    const request = new EventEmitter() as EventEmitter & {
      destroy: (error: Error) => void;
    };
    request.destroy = (error) => {
      request.emit('error', error);
      request.emit('close');
    };
    queueMicrotask(() => {
      const stream = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]);
      Object.assign(stream, {
        statusCode: status,
        headers: { 'content-type': 'application/dns-json' },
      });
      stream.once('close', () => request.emit('close'));
      callback(stream);
    });
    return request;
  });
}
beforeEach(() => {
  ports.lookup.mockResolvedValue([answer('198.18.0.5')]);
  reply(response());
});
afterEach(() => vi.resetAllMocks());

it('replaces an all-synthetic DNS answer with a pinned real public address over verified TLS', async () => {
  expect(await query()).toEqual(answer('104.20.23.154'));
  expect(ports.get).toHaveBeenCalledWith(
    expect.objectContaining({
      hostname: '1.1.1.1',
      servername: 'cloudflare-dns.com',
      path: '/dns-query?name=example.com&type=A',
      agent: false,
    }),
    expect.any(Function),
  );
  expect(ports.get.mock.calls[0]![0].rejectUnauthorized).not.toBe(false);
});
it('uses ordinary public system answers and public literals without querying another resolver', async () => {
  ports.lookup.mockResolvedValue([answer('8.8.8.8')]);
  expect(await query()).toEqual(answer('8.8.8.8'));
  expect(
    await resolveLocalBrowserPublicAddress(
      '104.16.1.2',
      localBrowserPublicAddress,
    ),
  ).toEqual(answer('104.16.1.2'));
  expect(ports.get).not.toHaveBeenCalled();
});
it.each([
  { answers: [answer('10.1.2.3')] },
  { answers: [answer('198.18.0.5'), answer('10.1.2.3')] },
  { answers: [answer('198.18.0.5'), answer('8.8.8.8')] },
  { answers: [{ address: '198.18.0.5', family: 6 }] },
  { answers: [] },
])(
  'does not reinterpret private, mixed, malformed or empty system answers %j',
  async ({ answers }) => {
    ports.lookup.mockResolvedValue(answers);
    await expect(query()).rejects.toThrow('LOCAL_BROWSER_POLICY_DENIED');
    expect(ports.get).not.toHaveBeenCalled();
  },
);
it.each([
  { Status: 2 },
  { TC: true },
  { Question: [{ name: 'other.example.', type: 1 }] },
  { Question: [{ name: 'example.com.', type: 28 }] },
  { Answer: [] },
  { Answer: [{ type: 1, data: '127.0.0.1' }] },
  { Answer: [{ type: 1, data: '198.18.0.5' }] },
  {
    Answer: [
      { type: 1, data: '104.20.23.154' },
      { type: 1, data: '10.1.2.3' },
    ],
  },
])(
  'rejects failed, unrelated, truncated or nonpublic DNS fallback %j',
  async (change) => {
    reply({ ...response(), ...change });
    await expect(query()).rejects.toThrow('LOCAL_BROWSER_POLICY_DENIED');
  },
);
it('refuses redirects and oversized or invalid bodies instead of treating them as public addresses', async () => {
  reply(response(), 302);
  await expect(query()).rejects.toThrow('LOCAL_BROWSER_POLICY_DENIED');
  reply(null, 200, 'x'.repeat(16 * 1024 + 1));
  await expect(query()).rejects.toThrow('LOCAL_BROWSER_POLICY_DENIED');
  reply(null, 200, '{bad-json');
  await expect(query()).rejects.toThrow('LOCAL_BROWSER_POLICY_DENIED');
});
