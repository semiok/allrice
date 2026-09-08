import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));
import { createPinnedMcpFetch } from './egress.js';

const endpoint = 'https://mcp.example.test/mcp';
const input = () => ({
  endpoint,
  bearerToken: 'synthetic-key',
  signal: new AbortController().signal,
  assertAuthorized: vi.fn(async () => {}),
});
beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.request.mockReset();
});
describe('P16 production egress boundary (isolated DNS/TLS transport-unit tests)', () => {
  it.each([
    '127.0.0.1',
    '169.254.169.254',
    '10.10.1.1',
    '198.18.0.1',
    '::1',
    'fc00::1',
  ])(
    'refuses DNS resolution into %s before opening any socket',
    async (address) => {
      mocks.lookup.mockResolvedValue([
        { address, family: address.includes(':') ? 6 : 4 },
      ]);
      await expect(
        createPinnedMcpFetch(input())(endpoint, { method: 'POST', body: '{}' }),
      ).rejects.toMatchObject({ code: 'MCP_SOURCE_DENIED' });
      expect(mocks.request).not.toHaveBeenCalled();
    },
  );
  it('refuses mixed public/private answers rather than selecting the public one', async () => {
    mocks.lookup.mockResolvedValue([
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(
      createPinnedMcpFetch(input())(endpoint, { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({ code: 'MCP_SOURCE_DENIED' });
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('pins the checked IP into the actual HTTPS lookup and prevents redirects', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    const request = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
      end: vi.fn(),
    });
    const response = Object.assign(new PassThrough(), {
      statusCode: 302,
      headers: { location: 'http://127.0.0.1/private' },
    });
    mocks.request.mockImplementation((_url, _options, callback) => {
      request.end.mockImplementation(() => callback(response));
      return request;
    });
    const authorized = input();
    await expect(
      createPinnedMcpFetch(authorized)(endpoint, {
        method: 'POST',
        headers: {
          cookie: 'not-forwarded',
          'proxy-authorization': 'not-forwarded',
        },
        body: '{}',
      }),
    ).rejects.toMatchObject({ code: 'MCP_SOURCE_DENIED' });
    const [url, options] = mocks.request.mock.calls[0]!;
    expect(url.href).toBe(endpoint);
    expect(options.headers.authorization).toBe('Bearer synthetic-key');
    expect(options.headers.cookie).toBeUndefined();
    expect(options.headers['proxy-authorization']).toBeUndefined();
    const resolved = vi.fn();
    options.lookup('mcp.example.test', {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(authorized.assertAuthorized).toHaveBeenCalledOnce();
    expect(mocks.request).toHaveBeenCalledOnce();
  });
  it('does not look up or connect after current authority is revoked', async () => {
    const authorized = input();
    authorized.assertAuthorized.mockRejectedValue(Error('revoked'));
    await expect(
      createPinnedMcpFetch(authorized)(endpoint, {
        method: 'POST',
        body: '{}',
      }),
    ).rejects.toThrow('revoked');
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
