import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNativeRunDiagnosticsHttpHandler } from './native-run-diagnostics-http.js';

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
const input = {
  runId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
};
const context = {
  actor: { type: 'user', id: 'owner' },
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
};
async function host(serviceSignal?: AbortSignal, summaryRead = vi.fn()) {
  const deps = {
    authenticate: vi.fn().mockResolvedValue(context),
    target: vi.fn().mockResolvedValue({ runId: input.runId, slices: [] }),
    read: vi.fn().mockResolvedValue({
      schemaVersion: 1,
      runId: input.runId,
      status: 'unavailable',
      reasons: ['source_receipts_missing'],
    }),
  };
  const subagents = {
    target: vi.fn().mockResolvedValue({}),
    read: summaryRead,
  };
  const handler = createNativeRunDiagnosticsHttpHandler(
    deps,
    subagents,
    serviceSignal,
  );
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (
    body: unknown = input,
    headers: Record<string, string> = {},
    path = '/internal/native-run-diagnostics',
  ) =>
    fetch(url + path, {
      method: 'POST',
      headers: {
        authorization: 'Bearer real_session_opaque_token',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { ...deps, request, server, subagents };
}
it('authenticates the real user and rechecks Run ownership after the independent reader', async () => {
  const h = await host();
  const response = await h.request();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(h.authenticate).toHaveBeenCalledTimes(2);
  expect(h.authenticate).toHaveBeenCalledWith('real_session_opaque_token', {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
  });
  expect(h.target).toHaveBeenCalledTimes(2);
  expect(h.read).toHaveBeenCalledTimes(1);
});
it('rejects a peer/foreign Run before reading its journal', async () => {
  const h = await host();
  h.target.mockRejectedValue({ code: 'not_found' });
  const response = await h.request();
  expect(response.status).toBe(404);
  expect(h.read).not.toHaveBeenCalled();
});
it('never accepts a caller-selected path, reader, source cut or browser Origin', async () => {
  const h = await host();
  for (const field of [
    'storageNamespace',
    'artifactId',
    'nativeSessionId',
    'seq',
  ]) {
    expect(
      (await h.request({ ...input, [field]: '/other/tenant' })).status,
    ).toBe(400);
  }
  expect(
    (await h.request(input, { origin: 'https://attacker.example' })).status,
  ).toBe(404);
  expect(h.authenticate).not.toHaveBeenCalled();
  expect(h.read).not.toHaveBeenCalled();
});
it('suppresses a completed diagnostic when the user logs out during its read', async () => {
  const h = await host();
  h.authenticate.mockResolvedValueOnce(context).mockResolvedValueOnce(null);
  const response = await h.request();
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('diagnostics');
});
it('returns no host path or raw parser error on read failure', async () => {
  const h = await host();
  h.read.mockRejectedValue(Error('secret /private/retained/source'));
  const response = await h.request();
  expect(response.status).toBe(503);
  expect(await response.text()).toBe('{"error":"diagnostics_unavailable"}');
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const summaryInput = {
  sessionId: input.runId,
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
};
it.each([
  [
    'NATIVE_QUERY_BINDING_UNAVAILABLE',
    undefined,
    'NATIVE_QUERY_BINDING_UNAVAILABLE',
    503,
  ],
  ['NATIVE_QUERY_HOST_MISMATCH', undefined, 'NATIVE_QUERY_HOST_MISMATCH', 503],
  [
    'private /tenant/user-content',
    'SESSION_QUERY_PERSISTENCE_FAILED',
    'SESSION_QUERY_PERSISTENCE_FAILED',
    503,
  ],
  ['private Bearer real_session_opaque_token', undefined, 'unclassified', 503],
  [
    'NATIVE_QUERY_SECRET_USER_CONTENT',
    'CUSTOM_PRIVATE_CODE',
    'unclassified',
    503,
  ],
  ['private', 'authentication_required', 'unclassified', 401],
  ['private', 'authorization_denied', 'unclassified', 404],
  ['private', 'not_found', 'unclassified', 404],
  ['private', 'tenant_context_invalid', 'unclassified', 404],
] as const)(
  'logs only an allowlisted reason for a summary failure (%s, %s)',
  async (message, code, reason, status) => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = await host();
    h.subagents.target.mockRejectedValue(
      Object.assign(Error(message), { code }),
    );
    const response = await h.request(
      { ...summaryInput, liveOnly: true },
      {},
      '/internal/native-subagent-summary',
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('x-allrice-native-query-error')).toBe(
      reason === 'NATIVE_QUERY_BINDING_UNAVAILABLE' && status === 503
        ? reason
        : null,
    );
    expect(await response.json()).toEqual({
      error:
        status === 401
          ? 'authentication_required'
          : status === 404
            ? 'not_found'
            : 'diagnostics_unavailable',
    });
    expect(h.subagents.read).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'Native diagnostics read failed',
      {
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        sessionId: summaryInput.sessionId,
        liveOnly: true,
        follow: false,
        reason,
      },
    );
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(
      /Bearer|real_session_opaque_token|private|user-content|SECRET_USER_CONTENT|CUSTOM_PRIVATE_CODE/,
    );
  },
);

it('classifies a parser failure without logging its input and preserves HTTP 400', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const h = await host();
  h.authenticate.mockRejectedValue(new SyntaxError('private JSON body'));
  const response = await h.request(
    summaryInput,
    {},
    '/internal/native-subagent-summary',
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'invalid_request' });
  expect(warning).toHaveBeenCalledWith(
    'Native diagnostics read failed',
    expect.objectContaining({
      reason: 'invalid_json',
      sessionId: summaryInput.sessionId,
    }),
  );
  expect(JSON.stringify(warning.mock.calls)).not.toContain('private JSON body');
});
it('aborts a summary on service shutdown and drains reader finally before HTTP close with the client connected', async () => {
  const entered = gate(),
    cleaning = gate(),
    release = gate();
  const service = new AbortController(),
    order: string[] = [];
  let observed: AbortSignal | undefined;
  const read = vi.fn(async (_target: unknown, signal: AbortSignal) => {
    observed = signal;
    try {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
        entered.resolve();
      });
      signal.throwIfAborted();
    } finally {
      order.push('reader:finally:start');
      cleaning.resolve();
      await release.promise;
      order.push('reader:finally:end');
    }
  });
  const h = await host(service.signal, read);
  let clientSettled = false,
    serverClosed = false;
  const pending = h
    .request(summaryInput, {}, '/internal/native-subagent-summary')
    .then(
      (response) => {
        clientSettled = true;
        return response;
      },
      (error: unknown) => {
        clientSettled = true;
        return error;
      },
    );
  let closing: Promise<void> | undefined;
  try {
    await entered.promise;
    // The existing Worker http_server shutdown step uses this exact order.
    service.abort();
    closing = new Promise<void>((resolve, reject) =>
      h.server.close((error) => {
        serverClosed = true;
        order.push('http:closed');
        if (error) reject(error);
        else resolve();
      }),
    );
    await cleaning.promise;
    expect(observed?.aborted).toBe(true);
    // Let Node process socket-close callbacks while cleanup is held by a
    // deterministic gate; this is not a product deadline or a sleep/retry.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(serverClosed).toBe(false);
    expect(clientSettled).toBe(false);
  } finally {
    release.resolve();
    service.abort();
    await closing;
  }
  expect(order).toEqual([
    'reader:finally:start',
    'reader:finally:end',
    'http:closed',
  ]);
  const response = await pending;
  expect(response).toBeInstanceOf(Response);
  expect((response as Response).status).toBe(503);
  expect(h.authenticate).toHaveBeenCalledTimes(1);
  expect(h.subagents.target).toHaveBeenCalledTimes(1);
});

it('refuses new requests after the HTTP service signal is already aborted', async () => {
  const service = new AbortController();
  service.abort();
  const h = await host(service.signal);
  expect(
    (await h.request(summaryInput, {}, '/internal/native-subagent-summary'))
      .status,
  ).toBe(503);
  expect((await h.request()).status).toBe(503);
  expect(h.authenticate).not.toHaveBeenCalled();
  expect(h.subagents.read).not.toHaveBeenCalled();
});

it('preserves the existing admitted diagnostics request contract during service shutdown', async () => {
  const service = new AbortController(),
    entered = gate(),
    release = gate();
  const h = await host(service.signal);
  let observed: AbortSignal | undefined;
  h.read.mockImplementation(async (_target, signal: AbortSignal) => {
    observed = signal;
    entered.resolve();
    await release.promise;
    return { status: 'unavailable' };
  });
  const pending = h.request();
  try {
    await entered.promise;
    service.abort();
    expect(observed?.aborted).toBe(false);
  } finally {
    release.resolve();
  }
  expect((await pending).status).toBe(200);
  expect(h.authenticate).toHaveBeenCalledTimes(2);
});
