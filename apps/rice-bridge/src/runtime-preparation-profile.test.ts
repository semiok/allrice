import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { localCommandToolchainImageV1 } from '@allrice/contracts';
import { bridgeRequest, BridgeClientError } from './client.js';
import { prepareAndReportLocalCommand } from './runtime-preparation.js';

let status = 200;
let body: string | undefined;
let disconnect = false;
const server = createServer((_request, response) => {
  if (disconnect) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    'content-type': 'application/json',
    connection: 'close',
  });
  if (body !== undefined) {
    response.end(body);
    return;
  }
  let submitted = '';
  _request.on('data', (chunk) => {
    submitted += chunk;
  });
  _request.on('end', () =>
    response.end(
      JSON.stringify(
        status === 200
          ? { profile: JSON.parse(submitted) }
          : { error: { message: 'synthetic report error' } },
      ),
    ),
  );
});
let origin: string;
beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  status = 200;
  body = undefined;
  disconnect = false;
});

function fixture() {
  const controller = new AbortController();
  const profile = {
    contractVersion: 1 as const,
    backend: 'local-vm-container-v1' as const,
    architecture: 'amd64' as const,
    imageDigest: localCommandToolchainImageV1,
    available: true,
  };
  const prepare = vi.fn(async () => profile);
  const report = vi.fn((verified: typeof profile) =>
    bridgeRequest({
      server: origin,
      path: '/api/v1/bridge/device/runtime-profile',
      method: 'POST',
      body: verified,
      maximumResponseBytes: 4096,
      timeoutMs: 1000,
      signal: controller.signal,
    }),
  );
  return {
    controller,
    profile,
    prepare,
    report,
    input: { signal: controller.signal, prepare, report },
  };
}

it('reports the verified physical profile once without retrying preparation', async () => {
  const f = fixture();
  expect(await prepareAndReportLocalCommand(f.input)).toEqual({
    profile: f.profile,
    reportFailed: false,
  });
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.report).toHaveBeenCalledExactlyOnceWith(f.profile);
});

it('does not turn a successful physical preflight into sandbox failure on an HTTP 503 report', async () => {
  status = 503;
  const f = fixture();
  expect(await prepareAndReportLocalCommand(f.input)).toEqual({
    profile: f.profile,
    reportFailed: true,
  });
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(f.report).toHaveBeenCalledTimes(1);
});

it.each([400, 401, 403, 404, 413])(
  'keeps explicit rejection (%s) fail closed',
  async (code) => {
    status = code;
    const f = fixture();
    await expect(prepareAndReportLocalCommand(f.input)).rejects.toBeInstanceOf(
      BridgeClientError,
    );
  },
);

it('keeps an invalid or oversized bounded response fail closed', async () => {
  const f = fixture();
  body = 'not JSON';
  await expect(prepareAndReportLocalCommand(f.input)).rejects.toBeInstanceOf(
    SyntaxError,
  );
  body = JSON.stringify({ padding: 'x'.repeat(5000) });
  await expect(prepareAndReportLocalCommand(f.input)).rejects.toMatchObject({
    status: 413,
  });
});

it.each([
  {},
  { error: { message: 'synthetic rejection' } },
  {
    profile: {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      architecture: 'arm64',
      imageDigest: localCommandToolchainImageV1,
      available: true,
    },
  },
  {
    profile: {
      contractVersion: 1,
      backend: 'local-vm-container-v1',
      architecture: 'amd64',
      imageDigest: localCommandToolchainImageV1,
      available: false,
    },
  },
])(
  'requires an exact profile acknowledgement, including on HTTP 200',
  async (response) => {
    body = JSON.stringify(response);
    await expect(
      prepareAndReportLocalCommand(fixture().input),
    ).rejects.toMatchObject({ status: 409 });
  },
);

it('separates a real transport disconnect from physical preparation', async () => {
  disconnect = true;
  const f = fixture();
  expect(await prepareAndReportLocalCommand(f.input)).toEqual({
    profile: f.profile,
    reportFailed: true,
  });
  expect(f.prepare).toHaveBeenCalledTimes(1);
});

it('does not classify programmer errors or rejected redirects as transport recovery', async () => {
  const f = fixture();
  for (const failure of [
    new TypeError('fetch failed'),
    new TypeError('fetch failed', { cause: Error('unexpected redirect') }),
  ]) {
    f.report.mockRejectedValueOnce(failure);
    await expect(prepareAndReportLocalCommand(f.input)).rejects.toBe(failure);
  }
});

it('recovers a request timeout but respects cancellation after a successful report', async () => {
  const f = fixture();
  f.report.mockRejectedValueOnce(
    new DOMException('synthetic timeout', 'TimeoutError'),
  );
  expect((await prepareAndReportLocalCommand(f.input)).reportFailed).toBe(true);
  f.report.mockImplementationOnce(async () => {
    f.controller.abort();
  });
  await expect(prepareAndReportLocalCommand(f.input)).rejects.toThrow();
});

it('never reports ready after a genuine preflight failure', async () => {
  const f = fixture(),
    failure = Error('synthetic physical failure');
  f.prepare.mockRejectedValue(failure);
  await expect(prepareAndReportLocalCommand(f.input)).rejects.toBe(failure);
  expect(f.report).not.toHaveBeenCalled();
});

it('does not continue after cancellation during profile reporting', async () => {
  const f = fixture();
  f.report.mockImplementation(async () => {
    f.controller.abort();
    f.controller.signal.throwIfAborted();
  });
  await expect(prepareAndReportLocalCommand(f.input)).rejects.toThrow();
});
