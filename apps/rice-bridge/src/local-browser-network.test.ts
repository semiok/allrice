import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserProfileSchema } from '@allrice/contracts';
import {
  localBrowserPublicAddress,
  localBrowserUrlAllowed,
  startLocalBrowserProxy,
} from './local-browser-network.js';
const profile = BrowserProfileSchema.parse({
  version: 1,
  origins: ['https://site.example'],
});
const closers: Array<() => Promise<void>> = [];
it('allows only the configured private site/port and refuses this computer through any interface alias', () => {
  const p = BrowserProfileSchema.parse({
    version: 1,
    network: 'local_sites',
    origins: ['http://10.250.254.253:8080'],
  });
  expect(localBrowserUrlAllowed('http://10.250.254.253:8080/report', p)).toBe(
    true,
  );
  for (const url of [
    'http://10.250.254.253:8081/report',
    'http://10.250.254.254:8080/report',
    'http://127.0.0.1:8080',
    'http://169.254.169.254',
    'http://100.100.100.200',
    'https://example.com/',
  ])
    expect(localBrowserUrlAllowed(url, p)).toBe(false);
  for (const item of Object.values(networkInterfaces())
    .flatMap((values) => values ?? [])
    .filter((item) => item.family === 'IPv4')) {
    const origin = `http://${item.address}:8080`;
    const own = BrowserProfileSchema.safeParse({
      version: 1,
      network: 'local_sites',
      origins: [origin],
    });
    if (own.success)
      expect(localBrowserUrlAllowed(origin + '/', own.data)).toBe(false);
  }
});
it('rejects a wrong private port before any current-authority check or upstream connection', async () => {
  const assertCurrent = vi.fn(async () => {});
  const proxy = await startLocalBrowserProxy({
    profile: BrowserProfileSchema.parse({
      version: 1,
      network: 'local_sites',
      origins: ['http://10.250.254.253:8080'],
    }),
    assertCurrent,
  });
  closers.push(proxy.close);
  const status = await new Promise((resolve, reject) => {
    const req = request(
      proxy.server,
      {
        path: 'http://10.250.254.253:8081/secret',
        headers: {
          'proxy-authorization':
            'Basic ' +
            Buffer.from(`${proxy.username}:${proxy.password}`).toString(
              'base64',
            ),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    req.once('error', reject);
    req.end();
  });
  expect(status).toBe(403);
  expect(assertCurrent).not.toHaveBeenCalled();
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
describe('P22 pinned public-only CONNECT boundary', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '198.18.0.1',
    '192.88.99.1',
    '0.0.0.0',
    '::1',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2001:0:ffff::1',
    '2002:7f00:1::',
    '64:ff9b::7f00:1',
    '2001:db8::1',
    'fe80::1%lo0',
    '3fff::1',
    'fc00::1',
    'ff00::1',
  ])('denies special/private address %s', (address) =>
    expect(localBrowserPublicAddress(address)).toBe(false),
  );
  it.each(['8.8.8.8', '104.16.1.2', '2606:4700:4700::1111'])(
    'permits ordinary public address %s',
    (address) => expect(localBrowserPublicAddress(address)).toBe(true),
  );
  it('does not allow scheme/port/subdomain/localhost/daily Chrome exceptions', () => {
    expect(
      localBrowserUrlAllowed('https://site.example/path?q=1', profile),
    ).toBe(true);
    for (const url of [
      'http://site.example/',
      'https://site.example:444/',
      'https://other.site.example/',
      'file:///etc/hosts',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://site.example/#fragment',
    ])
      expect(localBrowserUrlAllowed(url, profile)).toBe(false);
  });
  it('actual proxy socket rejects unauthenticated HTTP without resolving or opening upstream', async () => {
    const assertCurrent = vi.fn(async () => {});
    const proxy = await startLocalBrowserProxy({ profile, assertCurrent });
    closers.push(proxy.close);
    const result = await new Promise<number>((resolve, reject) => {
      const req = request(
        proxy.server,
        { path: 'http://127.0.0.1/secret' },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      req.once('error', reject);
      req.end();
    });
    expect(result).toBe(403);
    expect(assertCurrent).not.toHaveBeenCalled();
  });
  it('actual CONNECT socket issues a 407 challenge before any authorization or upstream work', async () => {
    const assertCurrent = vi.fn(async () => {});
    const proxy = await startLocalBrowserProxy({ profile, assertCurrent });
    closers.push(proxy.close);
    const result = await new Promise<{
      status: number;
      challenge: string | undefined;
    }>((resolve, reject) => {
      const req = request(proxy.server, {
        method: 'CONNECT',
        path: 'site.example:443',
      });
      req.once('connect', (response, socket) => {
        socket.destroy();
        resolve({
          status: response.statusCode!,
          challenge: response.headers['proxy-authenticate'],
        });
      });
      req.once('error', reject);
      req.end();
    });
    expect(result).toEqual({
      status: 407,
      challenge: 'Basic realm="AllRice browser"',
    });
    expect(assertCurrent).not.toHaveBeenCalled();
  });
});
