import { beforeEach, describe, it, expect, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  list: vi.fn(),
  register: vi.fn(),
  update: vi.fn(),
  credential: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listMaintenanceDeployments: mocks.list,
  registerMaintenanceDeployment: mocks.register,
  updateMaintenanceDeployment: mocks.update,
  rotateMaintenanceCredential: mocks.credential,
}));
import { DataAccessError, MaintenanceConflict } from '@allrice/database';
import { GET, POST } from './route';
import { PUT } from './[id]/route';
import { PUT as credential } from './[id]/credential/route';
describe('maintenance routes', () => {
  const origin = 'https://admin.allrice.test',
    url = origin + '/api/v1/admin/technical-assistant/maintenance',
    id = 'a675ff40-e4dd-487b-93c8-cf09f9af8832';
  const params = { params: Promise.resolve({ id }) };
  const request = (
    method = 'POST',
    body = '{}',
    headers: Record<string, string> = {
      origin,
      'content-type': 'application/json',
    },
  ) => new Request(url, { method, body, headers });
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ actor: { type: 'user', id } });
    mocks.list.mockResolvedValue({ deployments: [] });
    mocks.register.mockResolvedValue({ created: true });
    mocks.update.mockResolvedValue({ saved: true });
    mocks.credential.mockResolvedValue({ rotated: true });
  });
  it('enforces same origin and JSON media type before any writes', async () => {
    for (const action of [
      (r: Request) => POST(r),
      (r: Request) => PUT(r, params),
      (r: Request) => credential(r, params),
    ]) {
      expect(
        (
          await action(
            request('PUT', '{}', {
              origin: 'https://other.test',
              'content-type': 'application/json',
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await action(
            request('PUT', '{}', { origin, 'content-type': 'text/plain' }),
          )
        ).status,
      ).toBe(415);
    }
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.credential).not.toHaveBeenCalled();
  });
  it('returns no-store readback and bounded request errors, without bypassing admin checks', async () => {
    const response = await GET(new Request(url));
    expect(await response.json()).toEqual({ deployments: [] });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await POST(request('POST', 'x'.repeat(2001)))).status).toBe(400);
    expect((await PUT(request('PUT', 'x'.repeat(4001)), params)).status).toBe(
      400,
    );
    expect(
      (await credential(request('PUT', 'x'.repeat(1001)), params)).status,
    ).toBe(400);
    expect((await POST(request('POST', '{'))).status).toBe(400);
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    expect((await POST(request())).status).toBe(403);
    expect((await GET(new Request(url))).status).toBe(403);
  });
  it('passes exact request and exposes concurrent conflicts without retrying writes', async () => {
    await PUT(request('PUT', '{"expectedRevision":2}'), params);
    expect(mocks.update).toHaveBeenCalledWith(expect.anything(), id, {
      expectedRevision: 2,
    });
    mocks.register.mockRejectedValue(new MaintenanceConflict());
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'maintenance_configuration_conflict',
    });
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
});
