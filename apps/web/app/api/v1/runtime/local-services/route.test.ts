import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const ports = vi.hoisted(() => ({
  enabled: vi.fn(),
  serviceEnabled: vi.fn(),
  context: vi.fn(),
  action: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('../../../../../lib/identity/session', () => ({
  getRequestContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  localCommandFeatureEnabled: ports.enabled,
  localServiceFeatureEnabled: ports.serviceEnabled,
  localServiceUserAction: ports.action,
  requestLocalPreviewFromUser: ports.preview,
}));
import { GET, POST } from './route';
const context = {
  actor: { type: 'user', id: randomUUID() },
  organizationId: randomUUID(),
  workspaceId: randomUUID(),
};
const runId = randomUUID(),
  processId = randomUUID();
const request = (body?: unknown, origin = 'http://localhost') =>
  new Request(
    `http://localhost/api/v1/runtime/local-services?runId=${runId}&processId=${processId}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
beforeEach(() => {
  vi.clearAllMocks();
  ports.enabled.mockReturnValue(true);
  ports.serviceEnabled.mockReturnValue(true);
  ports.context.mockResolvedValue(context);
  ports.action.mockResolvedValue({ state: 'stopping' });
  ports.preview.mockResolvedValue({
    workspaceId: randomUUID(),
    endpointId: randomUUID(),
    previewUrl: 'https://p-synthetic.preview.allrice.invalid',
    pending: true,
  });
});
it('requires both execution feature gates before authentication', async () => {
  ports.serviceEnabled.mockReturnValue(false);
  expect((await GET(request())).status).toBe(404);
  expect(ports.context).not.toHaveBeenCalled();
  expect(ports.action).not.toHaveBeenCalled();
});
it('rejects cross-origin control and anonymous reads or input', async () => {
  expect(
    (await POST(request({ action: 'stop' }, 'https://attacker.invalid')))
      .status,
  ).toBe(403);
  ports.context.mockResolvedValue(null);
  expect((await GET(request())).status).toBe(401);
  expect((await POST(request({ action: 'stop' }))).status).toBe(401);
  expect(ports.action).not.toHaveBeenCalled();
});
it('uses the authenticated scope and returns only a stop intent', async () => {
  const response = await POST(request({ action: 'stop' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ service: { state: 'stopping' } });
  expect(ports.action).toHaveBeenCalledWith(
    context,
    runId,
    processId,
    'stop',
    undefined,
  );
  expect(response.headers.get('cache-control')).toContain('no-store');
});
it('rejects malformed requests and bounded input without reflecting supplied text', async () => {
  for (const body of [
    { action: 'input' },
    { action: 'stop', input: { text: 'SYNTHETIC_SECRET' } },
    { action: 'unknown' },
    { action: 'stop', extra: true },
  ]) {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('SYNTHETIC_SECRET');
  }
  expect(
    (await POST(request({ action: 'input', input: 'x'.repeat(18000) }))).status,
  ).toBe(413);
  expect(ports.action).not.toHaveBeenCalled();
});
it('never reveals database errors or user input in error responses', async () => {
  ports.action.mockRejectedValue(new Error('PRIVATE_DATABASE_DETAILS'));
  const response = await GET(request());
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain('PRIVATE_DATABASE_DETAILS');
});
it('preview accepts only process identity plus real session scope; never accepts job, URL or port authority', async () => {
  const make = (body: unknown, origin = 'http://localhost') =>
    new Request(
      `http://localhost/api/v1/runtime/local-services?processId=${processId}`,
      {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
  const response = await POST(make({ action: 'preview' }));
  expect(response.status).toBe(200);
  expect(ports.preview).toHaveBeenCalledExactlyOnceWith(context, processId);
  expect(await response.json()).toMatchObject({ pending: true });
  expect(ports.action).not.toHaveBeenCalled();
  for (const extra of [
    { port: 3100 },
    { url: 'http://localhost' },
    { jobLeaseToken: randomUUID() },
    { input: { text: 'secret' } },
  ])
    expect((await POST(make({ action: 'preview', ...extra }))).status).toBe(
      400,
    );
  expect(
    (await POST(make({ action: 'preview' }, 'https://attacker.invalid')))
      .status,
  ).toBe(403);
  expect(ports.preview).toHaveBeenCalledTimes(1);
});
