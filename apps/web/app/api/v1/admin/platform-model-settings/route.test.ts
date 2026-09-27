import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import {
  DataAccessError,
  PlatformModelSettingsConflict,
} from '@allrice/database';
import { GET, PUT } from './route';
const ports = vi.hoisted(() => ({
  context: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
}));
vi.mock('../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getPlatformModelSettings: ports.read,
  updatePlatformModelSettings: ports.save,
}));
const request = (origin = 'https://example.test') =>
  new Request('https://example.test/api', {
    method: 'PUT',
    headers: {
      host: 'example.test',
      origin,
      'content-type': 'application/json',
    },
    body: '{}',
  });
beforeEach(() => {
  vi.resetAllMocks();
  ports.context.mockResolvedValue({ actor: { type: 'user' } });
  ports.save.mockResolvedValue({ revision: 2 });
});
describe('platform model configuration HTTP boundary', () => {
  it('rejects cross-origin writes before accessing configuration', async () => {
    expect((await PUT(request('https://elsewhere.test'))).status).toBe(403);
    expect(ports.save).not.toHaveBeenCalled();
  });
  it.each([GET, PUT])('requires platform authority (%#)', async (handler) => {
    ports.context.mockRejectedValue(
      new DataAccessError('authorization_denied'),
    );
    expect((await handler(request())).status).toBe(403);
    expect(ports.save).not.toHaveBeenCalled();
    expect(ports.read).not.toHaveBeenCalled();
  });
  it('reports concurrent saves instead of overwriting newer settings', async () => {
    ports.save.mockRejectedValue(new PlatformModelSettingsConflict());
    expect((await PUT(request())).status).toBe(409);
  });
  it('never caches model configuration responses', async () => {
    const response = await PUT(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ settings: { revision: 2 } });
  });
});
