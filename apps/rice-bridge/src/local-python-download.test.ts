import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localPythonHttpTransport } from './local-python-client.js';
import {
  inputDownloadNetworkReason,
  LocalPythonInputDownloadError,
} from './local-python-download-error.js';

const bytes = Buffer.from('金额\n125.00\n');
const file = {
  objectId: randomUUID(),
  path: 'private-customer.csv',
  checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  sizeBytes: bytes.length,
  mediaType: 'text/csv',
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('missing listener');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return localPythonHttpTransport({
    server: `http://127.0.0.1:${address.port}`,
    id: randomUUID(),
    token: 'secret-device-token',
    leaseToken: randomUUID(),
  });
}

describe('fixed Python/Office input download diagnostics', () => {
  it('captures a real connection drop before headers without replay or private exception text', async () => {
    let requests = 0;
    const transport = await serve((request) => {
      requests++;
      request.socket.destroy();
    });
    const error = await transport
      .download(file, new AbortController().signal)
      .catch((e) => e);
    expect(error).toBeInstanceOf(LocalPythonInputDownloadError);
    expect(error).toMatchObject({
      code: 'INPUT_DOWNLOAD_UNAVAILABLE',
      diagnostic: {
        objectId: file.objectId,
        stage: 'response',
        reason: 'UND_ERR_SOCKET',
        httpStatus: null,
        expectedBytes: bytes.length,
        receivedBytes: 0,
      },
    });
    expect(requests).toBe(1);
    const summary = error.receiptSummary('office');
    expect(summary).toContain(file.objectId);
    expect(summary).not.toMatch(
      /secret-device-token|127\.0\.0\.1|private-customer|Bearer|金额/,
    );
    expect(summary.length).toBeLessThanOrEqual(500);
  });
  it('distinguishes a real interrupted body from a response failure and records received bytes', async () => {
    const transport = await serve((_request, response) => {
      response.writeHead(200, {
        'x-allrice-checksum': file.checksum,
        'content-length': String(bytes.length),
      });
      response.write(bytes.subarray(0, 4));
      setTimeout(() => response.destroy(), 30);
    });
    const error = await transport
      .download(file, new AbortController().signal)
      .catch((e) => e);
    expect(error).toMatchObject({
      code: 'INPUT_DOWNLOAD_UNAVAILABLE',
      diagnostic: {
        stage: 'body',
        reason: 'UND_ERR_SOCKET',
        httpStatus: 200,
        receivedBytes: 4,
      },
    });
  });
  it('keeps a real overall timeout distinct from user/lease cancellation', async () => {
    const transport = await serve((_request, response) => {
      response.writeHead(200, {
        'x-allrice-checksum': file.checksum,
        'content-length': String(bytes.length),
      });
      response.write(bytes.subarray(0, 4));
    });
    await expect(
      transport.download(file, AbortSignal.timeout(150)),
    ).rejects.toMatchObject({
      code: 'EXECUTION_REVOKED',
      diagnostic: {
        stage: 'body',
        reason: 'timeout',
        httpStatus: 200,
        receivedBytes: 4,
      },
    });
  });
  it.each([403, 503])(
    'retains the exact HTTP %i rejection without guessing a network failure',
    async (status) => {
      const transport = await serve((_request, response) => {
        response.writeHead(status);
        response.end('private upstream error');
      });
      const error = await transport
        .download(file, new AbortController().signal)
        .catch((e) => e);
      expect(error).toMatchObject({
        code: 'INPUT_VERSION_CHANGED',
        diagnostic: {
          stage: 'response',
          reason: 'http_rejected',
          httpStatus: status,
          receivedBytes: 0,
        },
      });
      expect(error.receiptSummary('python_charts')).not.toContain(
        'private upstream error',
      );
    },
  );
  it('retains exact input validation and differentiates changed bytes from connection failures', async () => {
    const transport = await serve((_request, response) => {
      response.writeHead(200, {
        'x-allrice-checksum': file.checksum,
        'content-length': String(bytes.length),
      });
      response.end(Buffer.alloc(bytes.length));
    });
    await expect(
      transport.download(file, new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'INPUT_VERSION_CHANGED',
      diagnostic: {
        stage: 'validation',
        reason: 'body_checksum',
        receivedBytes: bytes.length,
      },
    });
  });
  it.each(['TimeoutError', 'AbortError'])(
    'differentiates a transport %s and never includes arbitrary exception fields',
    async (name) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw Object.assign(
            Error('https://secret.invalid?token=secret private-path'),
            { name },
          );
        }),
      );
      const transport = localPythonHttpTransport({
        server: 'https://synthetic.invalid',
        id: randomUUID(),
        token: 'secret',
        leaseToken: randomUUID(),
      });
      await expect(
        transport.download(file, new AbortController().signal),
      ).rejects.toMatchObject({
        code: 'INPUT_DOWNLOAD_UNAVAILABLE',
        diagnostic: {
          reason: name === 'TimeoutError' ? 'timeout' : 'canceled',
          stage: 'response',
        },
      });
    },
  );
  it('classifies revoked authority separately and preserves an allowlisted nested cause only', async () => {
    const signal = AbortSignal.abort();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Error('private message');
      }),
    );
    const transport = localPythonHttpTransport({
      server: 'https://synthetic.invalid',
      id: randomUUID(),
      token: 'secret',
      leaseToken: randomUUID(),
    });
    await expect(transport.download(file, signal)).rejects.toMatchObject({
      code: 'EXECUTION_REVOKED',
      diagnostic: { reason: 'canceled' },
    });
    expect(
      inputDownloadNetworkReason({
        cause: { cause: { code: 'ENOTFOUND', message: 'secret' } },
      }),
    ).toBe('ENOTFOUND');
    expect(
      inputDownloadNetworkReason({ code: 'secret path', message: 'secret' }),
    ).toBe('network_unknown');
    const circular: { cause?: unknown } = {};
    circular.cause = circular;
    expect(inputDownloadNetworkReason(circular)).toBe('network_unknown');
  });
});
