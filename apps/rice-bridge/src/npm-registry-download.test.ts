import { EventEmitter } from 'node:events';
import type * as Https from 'node:https';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { RuntimeNpmPackageSchema } from '@allrice/contracts';
const ports = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: ports.lookup }));
vi.mock('node:https', () => ({ request: ports.request }));
import { downloadNpmArchive } from './npm-registry-download.js';
const pkg = RuntimeNpmPackageSchema.parse({
  name: 'is-number',
  version: '7.0.0',
  integrity:
    'sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==',
});
beforeEach(() => {
  ports.lookup.mockResolvedValue([{ address: '104.16.5.34', family: 4 }]);
});
afterEach(() => {
  ports.lookup.mockReset();
  ports.request.mockReset();
});
function transport(
  statusCode: number,
  bytes = Buffer.from('archive'),
  headers: Record<string, string> = {},
) {
  let stopped = false;
  ports.request.mockImplementation((_url, _options, callback) => {
    const request = Object.assign(new EventEmitter(), {
      end: () =>
        queueMicrotask(() => {
          const response = Object.assign(new EventEmitter(), {
            statusCode,
            headers,
            destroy: () => {
              stopped = true;
            },
          });
          callback(response);
          if (!stopped) {
            response.emit('data', bytes);
            if (!stopped) response.emit('end');
          }
        }),
      destroy: (error?: Error) => {
        stopped = true;
        if (error) queueMicrotask(() => request.emit('error', error));
      },
    });
    return request;
  });
  return () => stopped;
}
it('pins a checked public IP, retains canonical TLS hostname and sends no auth/proxy data', async () => {
  transport(200);
  expect(await downloadNpmArchive(pkg, AbortSignal.timeout(1000))).toEqual(
    Buffer.from('archive'),
  );
  const [url, options] = ports.request.mock.calls[0]!;
  expect(url.href).toBe(
    'https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz',
  );
  expect(options).toMatchObject({
    agent: false,
    family: 4,
    headers: {
      Accept: 'application/octet-stream',
      'Accept-Encoding': 'identity',
    },
  });
  expect(options.headers.authorization).toBeUndefined();
  const callback = vi.fn();
  options.lookup('registry.npmjs.org', {}, callback);
  expect(callback).toHaveBeenCalledWith(null, '104.16.5.34', 4);
});
it.each([301, 302, 307, 308, 401, 404, 500])(
  'rejects %s without following redirects or consuming an unbounded body',
  async (status) => {
    const stopped = transport(status, Buffer.alloc(1), {
      location: 'http://169.254.169.254/',
    });
    await expect(
      downloadNpmArchive(pkg, AbortSignal.timeout(1000)),
    ).rejects.toThrow('DEPENDENCY_DOWNLOAD_REJECTED');
    expect(stopped()).toBe(true);
    expect(ports.request).toHaveBeenCalledTimes(1);
  },
);
it('rejects oversized and encoded responses before use', async () => {
  transport(200, Buffer.alloc(131073));
  await expect(
    downloadNpmArchive(pkg, AbortSignal.timeout(1000)),
  ).rejects.toThrow('DEPENDENCY_ARCHIVE_LIMIT');
  transport(200, Buffer.from('gzip'), { 'content-encoding': 'gzip' });
  await expect(
    downloadNpmArchive(pkg, AbortSignal.timeout(1000)),
  ).rejects.toThrow('DEPENDENCY_DOWNLOAD_REJECTED');
});
it('rejects mixed public/private DNS answers before making any HTTP request', async () => {
  ports.lookup.mockResolvedValue([
    { address: '104.16.5.34', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(
    downloadNpmArchive(pkg, AbortSignal.timeout(1000)),
  ).rejects.toThrow('DEPENDENCY_SOURCE_DENIED');
  expect(ports.request).not.toHaveBeenCalled();
});
it('cancels stalled DNS instead of waiting indefinitely or issuing a late request', async () => {
  ports.lookup.mockReturnValue(new Promise(() => {}));
  const abort = new AbortController();
  const pending = downloadNpmArchive(pkg, abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow('EXECUTION_REVOKED');
  expect(ports.request).not.toHaveBeenCalled();
});
it.skipIf(!process.env.ALLRICE_REGISTRY_TEST_IPV4)(
  'actual public npm TLS download (test DNS pinned to an independently verified public A record)',
  async () => {
    const actual = await vi.importActual<typeof Https>('node:https');
    ports.request.mockImplementation(actual.request);
    ports.lookup.mockResolvedValue([
      { address: process.env.ALLRICE_REGISTRY_TEST_IPV4, family: 4 },
    ]);
    const bytes = await downloadNpmArchive(pkg, AbortSignal.timeout(15000));
    expect(
      `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    ).toBe(pkg.integrity);
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes.length).toBeLessThan(131072);
  },
  20000,
);
