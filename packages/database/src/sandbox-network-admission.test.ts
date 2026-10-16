import { describe, expect, it, vi } from 'vitest';
import { createSandboxNetworkAdmission } from './sandbox-network-admission.ts';

const request = (origins = ['https://pypi.org']) => ({
  mode: 'controlled_https',
  origins,
});
const response = (hostname: string, type: 1 | 28, data?: string, ttl = 60) => ({
  Status: 0,
  TC: false,
  Question: [{ name: hostname + '.', type }],
  Answer: data ? [{ name: hostname, type, TTL: ttl, data }] : [],
});
const publicReply = (hostname: string, type: 1 | 28) =>
  Promise.resolve(
    response(hostname, type, type === 1 ? '151.101.0.223' : undefined),
  );

describe('automatic sandbox destination admission', () => {
  it('checks only hostnames, deduplicates concurrent callers and expires positive results at DNS TTL', async () => {
    let now = 0;
    const query = vi.fn(async (host: string, type: 1 | 28) =>
      response(host, type, type === 1 ? '151.101.0.223' : undefined, 2),
    );
    const check = createSandboxNetworkAdmission(query, () => now);
    await Promise.all([check(request()), check(request())]);
    expect(query.mock.calls).toEqual([
      ['pypi.org', 1],
      ['pypi.org', 28],
    ]);
    now = 1999;
    await check(request());
    expect(query).toHaveBeenCalledTimes(2);
    now = 2000;
    await check(request());
    expect(query).toHaveBeenCalledTimes(4);
  });
  it.each([
    '0.0.0.0',
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.0.1',
    '100.64.0.1',
    '::',
    '::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ])('blocks filtered/private/metadata answer %s', async (ip) => {
    const type = ip.includes(':') ? 28 : 1;
    const query = vi.fn(async (host: string, q: 1 | 28) =>
      response(host, q, q === type ? ip : undefined),
    );
    await expect(
      createSandboxNetworkAdmission(query)(request()),
    ).rejects.toThrow('sandbox_network_destination_blocked');
  });
  it('rejects mixed public/private answers and does not cache refusal', async () => {
    const query = vi.fn(async (host: string, type: 1 | 28) => ({
      ...response(host, type),
      Answer:
        type === 1
          ? [
              { type: 1, TTL: 60, data: '151.101.0.223' },
              { type: 1, TTL: 60, data: '10.0.0.1' },
            ]
          : [],
    }));
    const check = createSandboxNetworkAdmission(query);
    await expect(check(request())).rejects.toThrow(
      'sandbox_network_destination_blocked',
    );
    query.mockImplementation(publicReply);
    await expect(check(request())).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(4);
  });
  it.each([
    'http://pypi.org',
    'https://127.0.0.1',
    'https://metadata.internal',
    'https://*.example.com',
    'https://user:pass@example.com',
    'https://example.com/secret',
    'https://example.com:444',
  ])('refuses invalid destination %s before a lookup', async (origin) => {
    const query = vi.fn(publicReply);
    await expect(
      createSandboxNetworkAdmission(query)(request([origin])),
    ).rejects.toThrow('sandbox_network_destination_blocked');
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    'transport',
    'nxdomain',
    'empty',
    'wrong-question',
    'truncated',
    'malformed',
  ])(
    'keeps %s distinct from a malicious verdict, without a cached fallback',
    async (kind) => {
      let now = 0;
      const query = vi.fn(publicReply),
        check = createSandboxNetworkAdmission(query, () => now);
      await check(request());
      now = 60000;
      query.mockImplementation(async (host, type) => {
        if (kind === 'transport') throw Error('upstream unavailable');
        if (kind === 'malformed') return null as never;
        return {
          ...response(kind === 'wrong-question' ? 'other.example' : host, type),
          Status: kind === 'nxdomain' ? 3 : 0,
          TC: kind === 'truncated',
        };
      });
      await expect(check(request())).rejects.toThrow(
        'sandbox_network_check_unavailable',
      );
      query.mockImplementation(publicReply);
      await expect(check(request())).resolves.toBeUndefined();
      expect(query).toHaveBeenCalledTimes(6);
    },
  );
  it('does not admit a partially checked set of destinations', async () => {
    const query = vi.fn(async (host: string, type: 1 | 28) =>
      response(
        host,
        type,
        type === 1
          ? host === 'blocked.example'
            ? '0.0.0.0'
            : '151.101.0.223'
          : undefined,
      ),
    );
    await expect(
      createSandboxNetworkAdmission(query)(
        request(['https://pypi.org', 'https://blocked.example']),
      ),
    ).rejects.toThrow('sandbox_network_destination_blocked');
  });
  it('bounds pending work instead of admitting unchecked requests under load', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const check = createSandboxNetworkAdmission(async (host, type) => {
      await gate;
      return publicReply(host, type);
    });
    const jobs = Array.from({ length: 64 }, (_, i) =>
      check(request([`https://host${i}.example.com`])),
    );
    await expect(check(request())).rejects.toThrow(
      'sandbox_network_check_unavailable',
    );
    release();
    await Promise.all(jobs);
  });
});
