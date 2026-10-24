import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createNativeRunDiagnosticsHttpHandler } from './native-run-diagnostics-http.js';

const servers: Server[] = [];
afterEach(async () => {
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
async function host() {
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
  const handler = createNativeRunDiagnosticsHttpHandler(deps);
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/internal/native-run-diagnostics`;
  const request = (
    body: unknown = input,
    headers: Record<string, string> = {},
  ) =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer real_session_opaque_token',
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { ...deps, request };
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
