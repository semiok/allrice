import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const port = vi.hoisted(() => ({
  context: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../../../../../../lib/identity/session', () => ({
  getRequestContext: port.context,
}));
vi.mock('@allrice/database', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getBridgeSandboxNetwork: port.read,
  updateBridgeSandboxNetwork: port.update,
}));
import { RuntimePolicyError } from '@allrice/database';
import { GET, PATCH } from './route';
const workspace = randomUUID(),
  device = randomUUID(),
  context = {
    actor: { type: 'user', id: randomUUID() },
    organizationId: randomUUID(),
  };
const profile = {
  version: 1,
  mode: 'controlled_https',
  origins: ['https://pypi.org'],
  allowInputTransfer: false,
};
const change = { expectedVersion: 0, enabled: true, profile };
const route = { params: Promise.resolve({ id: device }) };
function request(
  options: {
    origin?: string;
    type?: string;
    body?: unknown;
    get?: boolean;
  } = {},
) {
  return new Request(
    `https://tenant.example/api/v1/bridge/devices/${device}/sandbox-network?workspaceId=${workspace}`,
    options.get
      ? {}
      : {
          method: 'PATCH',
          headers: {
            origin: options.origin ?? 'https://tenant.example',
            'content-type': options.type ?? 'application/json',
          },
          body: JSON.stringify(options.body ?? change),
        },
  );
}
beforeEach(() => {
  vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '1');
  port.context.mockResolvedValue(context);
  port.read.mockResolvedValue({ version: 0, enabled: false, profile: null });
  port.update.mockResolvedValue({ version: 1, enabled: true, profile });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
it('reads the authenticated owner scope and sends only the versioned change to the authority service', async () => {
  const read = await GET(request({ get: true }), route);
  expect(read.status).toBe(200);
  expect(read.headers.get('cache-control')).toBe('private, no-store');
  expect(await read.json()).toEqual({
    version: 0,
    enabled: false,
    profile: null,
  });
  expect(port.read).toHaveBeenCalledWith(context, workspace, device);
  const update = await PATCH(request(), route);
  expect(update.status).toBe(200);
  expect(port.update).toHaveBeenCalledWith(context, workspace, device, change);
});
it.each([
  'other-origin',
  'null-origin',
  'text-body',
  'oversize',
  'logged-out',
  'disabled',
])('refuses %s before a grant can be written', async (mode) => {
  if (mode === 'logged-out') port.context.mockResolvedValue(null);
  if (mode === 'disabled') vi.stubEnv('ALLRICE_SANDBOX_NETWORK_ENABLED', '0');
  const response = await PATCH(
    request(
      mode === 'other-origin'
        ? { origin: 'https://other.example' }
        : mode === 'null-origin'
          ? { origin: 'null' }
          : mode === 'text-body'
            ? { type: 'text/plain' }
            : mode === 'oversize'
              ? { body: { text: 'x'.repeat(17000) } }
              : {},
    ),
    route,
  );
  expect(response.status).toBe(
    mode === 'logged-out'
      ? 401
      : mode === 'disabled'
        ? 404
        : mode === 'other-origin' || mode === 'null-origin'
          ? 403
          : 400,
  );
  expect(port.update).not.toHaveBeenCalled();
});
it('returns conflict for a stale settings version and never reports a saved grant', async () => {
  port.update.mockRejectedValue(
    new RuntimePolicyError('bridge_network_settings_conflict'),
  );
  const response = await PATCH(request(), route);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: { message: '设置已变化，请重新打开后再保存。' },
  });
});
