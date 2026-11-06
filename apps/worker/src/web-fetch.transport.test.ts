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
    const request = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn((error: Error) => {
        request.emit('error', error);
        queueMicrotask(() => request.emit('close'));
      }),
      end: () => {
        callback(response);
        response.on('end', () => queueMicrotask(() => request.emit('close')));
        response.end(body);
      },
    });
    return request;
  };
}

beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.http.mockReset();
  mocks.https.mockReset();
});

describe('web.fetch pinned DNS transport', () => {
  it.each([
    'text/html',
    'text/plain',
    'text/markdown',
    'application/json',
    'application/xml',
    'text/xml',
  ])(
    'keeps %s allowed, the 20k extracted cap and the actual non-2xx status',
    async (mime) => {
      mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
      mocks.https.mockImplementation(
        respond(404, { 'content-type': mime }, 'x'.repeat(20001)),
      );
      const result = await fetchPublicWebPage('https://source.test');
      expect(result.statusCode).toBe(404);
      expect(result.body).toEqual({ kind: 'text', content: 'x'.repeat(20000) });
      expect(result.truncated).toBe(true);
      expect(result).not.toHaveProperty('externalContent');
    },
  );

  it.each([
    ['application/octet-stream', 'ok', 'WEB_CONTENT_TYPE_BLOCKED'],
    ['text/plain', 'x'.repeat(750001), 'WEB_RESPONSE_TOO_LARGE'],
  ])('retains the MIME/network-byte gate: %s', async (mime, body, code) => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    mocks.https.mockImplementation(
      respond(200, { 'content-type': mime }, body),
    );
    await expect(
      fetchPublicWebPage('https://source.test'),
    ).rejects.toMatchObject({ code });
  });

  it('checks each redirect and refuses the fourth redirect', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    mocks.https.mockImplementation(respond(302, { location: '/again' }));
    await expect(
      fetchPublicWebPage('https://source.test'),
    ).rejects.toMatchObject({ code: 'WEB_REDIRECT_INVALID' });
    expect(mocks.lookup).toHaveBeenCalledTimes(4);
  });

  it('joins DNS before honoring abort and never opens a late HTTP socket', async () => {
    let release!: (value: unknown) => void;
    mocks.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    let settled = false;
    const pending = fetchPublicWebPage(
      'https://source.test',
      controller.signal,
    ).finally(() => {
      settled = true;
    });
    controller.abort(new Error('cancel'));
    await Promise.resolve();
    expect(settled).toBe(false);
    release([{ address: '1.1.1.1', family: 4 }]);
    await expect(pending).rejects.toThrow('cancel');
    expect(mocks.https).not.toHaveBeenCalled();
  });

  it('passes abort to HTTP and does not settle at error before close', async () => {
    mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    const request = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    });
    mocks.https.mockReturnValue(request);
    const controller = new AbortController();
    let settled = false;
    const pending = fetchPublicWebPage(
      'https://source.test',
      controller.signal,
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(mocks.https).toHaveBeenCalled());
    expect(mocks.https.mock.calls[0]![1].signal).toBe(controller.signal);
    controller.abort(new Error('user abort'));
    request.emit('error', controller.signal.reason);
    await Promise.resolve();
    expect(settled).toBe(false);
    request.emit('close');
    await expect(pending).rejects.toThrow('user abort');
  });
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

  it('resolves TUN fake IPs independently and pins only the confirmed public address', async () => {
    mocks.lookup.mockResolvedValue([{ address: '198.18.0.182', family: 4 }]);
    mocks.https.mockImplementation((url, options, callback) => {
      if (typeof options === 'function') {
        const body = JSON.stringify({
          Status: 0,
          Answer: url.path.endsWith('type=A')
            ? [{ type: 1, data: '104.26.0.67' }]
            : [],
        });
        return respond(200, {}, body)(url, {}, options);
      }
      return respond(200, { 'content-type': 'text/plain' }, 'public document')(
        url,
        options,
        callback,
      );
    });
    const result = await fetchPublicWebPage(
      'https://docs.openclaw.ai/concepts/features',
    );
    expect(result.body.content).toContain('public document');
    const requests = mocks.https.mock.calls.filter(
      ([, , callback]) => typeof callback === 'function',
    );
    expect(requests).toHaveLength(1);
    const [url, options] = requests[0]!;
    const resolved = vi.fn();
    options.lookup(url.hostname, {}, resolved);
    expect(resolved).toHaveBeenCalledWith(null, '104.26.0.67', 4);
    expect(url.hostname).toBe('docs.openclaw.ai');
  });

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
