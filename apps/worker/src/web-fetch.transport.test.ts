import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  http: vi.fn(),
  https: vi.fn(),
}));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:http', () => ({ request: mocks.http }));
vi.mock('node:https', () => ({ request: mocks.https }));
import { fetchPublicWebPage } from './web-fetch.js';

function respond(status: number, headers: Record<string, string>, body = '') {
  return (_url: URL, _options: unknown, callback: (value: unknown) => void) => {
    const response = Object.assign(new PassThrough(), {
      statusCode: status,
      headers,
    });
    return Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
      end: () => {
        callback(response);
        response.end(body);
      },
    });
  };
}

beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.http.mockReset();
  mocks.https.mockReset();
});

describe('web.fetch pinned DNS transport', () => {
  it.each([
    { protocol: 'http:', address: '1.1.1.1', family: 4 },
    { protocol: 'https:', address: '2606:4700:4700::1111', family: 6 },
  ])(
    'pins the validated IP for $protocol and keeps the hostname',
    async (entry) => {
      const address = { address: entry.address, family: entry.family };
      mocks.lookup.mockResolvedValue([address]);
      const transport = entry.protocol === 'http:' ? mocks.http : mocks.https;
      transport.mockImplementation(
        respond(200, { 'content-type': 'text/plain' }, 'ok'),
      );
      const endpoint = `${entry.protocol}//web.example.test/document`;
      await expect(fetchPublicWebPage(endpoint)).resolves.toMatchObject({
        url: endpoint,
      });
      const [url, options] = transport.mock.calls[0]!;
      expect(url.href).toBe(endpoint);
      expect(options.family).toBe(address.family);
      expect(options.rejectUnauthorized).toBeUndefined();
      expect(options.servername).toBeUndefined();
      const scalar = vi.fn();
      options.lookup(url.hostname, {}, scalar);
      expect(scalar).toHaveBeenCalledWith(
        null,
        address.address,
        address.family,
      );
      const all = vi.fn();
      options.lookup(url.hostname, { all: true }, all);
      expect(all).toHaveBeenCalledWith(null, [address]);
      expect(mocks.lookup).toHaveBeenCalledWith(url.hostname, {
        all: true,
        verbatim: true,
      });
    },
  );

  it('checks DNS again for a redirect and refuses private/mixed answers before a second socket', async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
      .mockResolvedValueOnce([
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    mocks.https.mockImplementation(respond(302, { location: '/second' }));
    await expect(
      fetchPublicWebPage('https://web.example.test/first'),
    ).rejects.toMatchObject({
      code: 'WEB_ADDRESS_BLOCKED',
    });
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.https).toHaveBeenCalledOnce();
    expect(mocks.http).not.toHaveBeenCalled();
  });
});
