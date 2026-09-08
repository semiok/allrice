import type { LookupOptions } from 'node:dns';
import { createConnection, createServer, type LookupFunction } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createPinnedLookup } from './pinned-lookup.js';

describe('pinned address Node DNS callback adapter', () => {
  it.each([
    { address: '1.1.1.1', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ])('returns only the pinned $address in either callback shape', (address) => {
    const pinned = createPinnedLookup(address);
    const scalar = vi.fn();
    pinned('ignored.example.test', {}, scalar);
    expect(scalar).toHaveBeenCalledWith(null, address.address, address.family);
    const all = vi.fn();
    pinned('ignored.example.test', { all: true, hints: 1024 }, all);
    expect(all).toHaveBeenCalledWith(null, [address]);
  });

  it('snapshots the validated address and does not retain caller mutation', () => {
    const address = { address: '1.1.1.1', family: 4 };
    const pinned = createPinnedLookup(address);
    address.address = '127.0.0.1';
    const first = vi.fn();
    pinned('ignored.example.test', { all: true }, first);
    expect(first).toHaveBeenCalledWith(null, [
      { address: '1.1.1.1', family: 4 },
    ]);
    first.mock.calls[0]![1][0].address = '127.0.0.1';
    const second = vi.fn();
    pinned('ignored.example.test', { all: true }, second);
    expect(second).toHaveBeenCalledWith(null, [
      { address: '1.1.1.1', family: 4 },
    ]);
  });
});

// Real node:net sockets, with no network/fetch mock. Loopback is only the
// adapter fixture; production callers still deny private DNS before using it.
describe('native Node automatic-family-selection regression', () => {
  async function connectToFixture(lookup: LookupFunction, family = 0) {
    const server = createServer((socket) => socket.end('pinned-native-ok'));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected local TCP fixture');
    const socket = createConnection({
      host: 'pinned-native.invalid',
      port: address.port,
      autoSelectFamily: true,
      family,
      lookup,
    });
    try {
      return await new Promise<string>((resolve, reject) => {
        let content = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => (content += chunk));
        socket.once('end', () => resolve(content));
        socket.once('error', reject);
        socket.setTimeout(2_000, () =>
          socket.destroy(new Error('Native fixture connection timed out')),
        );
      });
    } finally {
      socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  it('reproduces the legacy scalar callback failure when Node requests all:true', async () => {
    const optionsSeen: LookupOptions[] = [];
    await expect(
      connectToFixture((_host, options, callback) => {
        optionsSeen.push(options);
        callback(null, '127.0.0.1', 4);
      }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_IP_ADDRESS' });
    expect(optionsSeen).toEqual([expect.objectContaining({ all: true })]);
  });

  it.each([0, 4])(
    'connects with the real Node net path, family=%s',
    async (family) => {
      const optionsSeen: LookupOptions[] = [];
      const pinned = createPinnedLookup({ address: '127.0.0.1', family: 4 });
      await expect(
        connectToFixture((host, options, callback) => {
          optionsSeen.push(options);
          pinned(host, options, callback);
        }, family),
      ).resolves.toBe('pinned-native-ok');
      expect(optionsSeen).toHaveLength(1);
      expect(Boolean(optionsSeen[0]!.all)).toBe(family === 0);
    },
  );
});
