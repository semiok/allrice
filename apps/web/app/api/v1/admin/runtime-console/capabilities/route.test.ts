import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  inventory: vi.fn(),
  skills: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readRuntimeCapabilityInventory: mocks.inventory,
  listPlatformNativeSkills: mocks.skills,
}));
import { GET } from './route';
const request = () =>
  new Request('https://allrice.test/api/v1/admin/runtime-console/capabilities');
describe('admin capability facts API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({});
    mocks.inventory.mockResolvedValue({
      checkedAt: new Date().toISOString(),
      workers: [],
      publications: [],
    });
    mocks.skills.mockResolvedValue([]);
  });
  it('requires administrator authentication before reading installation or tenant facts', async () => {
    mocks.auth.mockRejectedValue(
      new DataAccessError('authentication_required'),
    );
    expect((await GET(request())).status).toBe(401);
    expect(mocks.inventory).not.toHaveBeenCalled();
  });
  it('returns uncached facts and does not fabricate zero counts on a database error', async () => {
    const response = await GET(request());
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      workers: [],
      publications: [],
      skills: [],
    });
    mocks.inventory.mockRejectedValue(Error('synthetic-private-database-url'));
    const failed = await GET(request());
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('synthetic-private');
  });
});
