import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { resolvePublicAddress } from './public-address.js';

const ports = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: ports.lookup }));
vi.mock('node:https', () => ({ get: ports.get }));
const address = (value: string) => ({ address: value, family: 4 });
const publicOnly = (value: string) => value === '104.16.1.2';
let resolve: typeof resolvePublicAddress;
let now: number;

function reply(ttl: unknown = 300, values = ['104.16.1.2']) {
  ports.get.mockImplementation((options, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      destroy: (error: Error) => void;
    };
    req.destroy = (error) => {
      req.emit('error', error);
      req.emit('close');
    };
    queueMicrotask(() => {
      const hostname = new URL(
        'https://resolver.invalid' + options.path,
      ).searchParams.get('name');
      const body = {
        Status: 0,
        TC: false,
        Question: [{ name: hostname, type: 1 }],
        Answer: values.map((data) => ({ type: 1, data, TTL: ttl })),
      };
      const res = Readable.from([Buffer.from(JSON.stringify(body))]);
      Object.assign(res, {
        statusCode: 200,
        headers: { 'content-type': 'application/dns-json' },
      });
      res.once('close', () => req.emit('close'));
      callback(res);
    });
    return req;
  });
}
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  ports.lookup.mockResolvedValue([address('198.18.0.1')]);
  reply();
  resolve = (await import('./public-address.js')).resolvePublicAddress;
});
afterEach(() => vi.restoreAllMocks());

it('shares verified fallback resolution across concurrent package downloads while checking system DNS each time', async () => {
  const result = await Promise.all(
    Array.from({ length: 10 }, () => resolve('registry.npmjs.org', publicOnly)),
  );
  expect(result).toEqual(Array(10).fill(address('104.16.1.2')));
  expect(ports.get).toHaveBeenCalledTimes(1);
  await resolve('registry.npmjs.org', publicOnly);
  expect(ports.get).toHaveBeenCalledTimes(1);
  expect(ports.lookup).toHaveBeenCalledTimes(11);
});

it.each([1, 300])(
  'expires at the DNS TTL with a 30-second cap (TTL %i)',
  async (ttl) => {
    reply(ttl);
    await resolve('registry.npmjs.org', publicOnly);
    now += Math.min(ttl, 30) * 1000 - 1;
    await resolve('registry.npmjs.org', publicOnly);
    expect(ports.get).toHaveBeenCalledTimes(1);
    now++;
    reply(ttl, ['127.0.0.1']);
    await expect(resolve('registry.npmjs.org', publicOnly)).rejects.toThrow(
      'PUBLIC_ADDRESS_DENIED',
    );
    expect(ports.get).toHaveBeenCalledTimes(2);
  },
);

it.each([undefined, 0, -1, '300', 1.5])(
  'does not reuse an absent or invalid TTL (%s)',
  async (ttl) => {
    // undefined must be represented explicitly rather than use reply's default.
    reply(ttl === undefined ? null : ttl);
    await resolve('registry.npmjs.org', publicOnly);
    await resolve('registry.npmjs.org', publicOnly);
    expect(ports.get).toHaveBeenCalledTimes(2);
  },
);

it('never lets a cached public answer override private/mixed system DNS or a stricter caller policy', async () => {
  const saved = await resolve('registry.npmjs.org', publicOnly);
  saved.address = '127.0.0.1';
  expect(await resolve('registry.npmjs.org', publicOnly)).toEqual(
    address('104.16.1.2'),
  );
  await expect(resolve('registry.npmjs.org', () => false)).rejects.toThrow(
    'PUBLIC_ADDRESS_DENIED',
  );
  for (const answers of [
    [address('10.0.0.1')],
    [address('198.18.0.1'), address('10.0.0.1')],
    [address('198.18.0.1'), address('104.16.1.2')],
  ]) {
    ports.lookup.mockResolvedValue(answers);
    await expect(resolve('registry.npmjs.org', publicOnly)).rejects.toThrow(
      'PUBLIC_ADDRESS_DENIED',
    );
  }
  expect(ports.get).toHaveBeenCalledTimes(1);
});

it('does not cache failed mixed fallback answers', async () => {
  reply(300, ['104.16.1.2', '10.0.0.1']);
  await expect(resolve('registry.npmjs.org', publicOnly)).rejects.toThrow(
    'PUBLIC_ADDRESS_DENIED',
  );
  reply();
  expect(await resolve('registry.npmjs.org', publicOnly)).toEqual(
    address('104.16.1.2'),
  );
  expect(ports.get).toHaveBeenCalledTimes(2);
});

it('fails closed on resolver outage after expiry, and retries resolution on a later call', async () => {
  await resolve('registry.npmjs.org', publicOnly);
  now += 30_000;
  ports.get.mockImplementation(() => {
    const req = new EventEmitter();
    queueMicrotask(() => {
      req.emit('error', new Error('ECONNRESET'));
      req.emit('close');
    });
    return req;
  });
  await expect(resolve('registry.npmjs.org', publicOnly)).rejects.toThrow(
    'PUBLIC_ADDRESS_DENIED',
  );
  reply();
  expect(await resolve('registry.npmjs.org', publicOnly)).toEqual(
    address('104.16.1.2'),
  );
  expect(ports.get).toHaveBeenCalledTimes(3);
});

it('evicts old entries instead of retaining unbounded hostnames', async () => {
  for (let i = 0; i < 65; i++) await resolve(`h${i}.example`, publicOnly);
  await resolve('h64.example', publicOnly);
  expect(ports.get).toHaveBeenCalledTimes(65);
  await resolve('h0.example', publicOnly);
  expect(ports.get).toHaveBeenCalledTimes(66);
});
