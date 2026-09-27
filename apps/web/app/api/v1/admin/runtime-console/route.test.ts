import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  operations: vi.fn(),
  tenants: vi.fn(),
  runtimes: vi.fn(),
}));
vi.mock('../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  readOperationsInventory: mocks.operations,
  listTenantRuntimeInventory: mocks.tenants,
  listDshRuntimeInventory: mocks.runtimes,
}));
import { GET } from './route';
const request = () =>
  new Request('https://admin.allrice.test/api/v1/admin/runtime-console');
describe('admin operational resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({});
    mocks.tenants.mockResolvedValue([]);
    mocks.runtimes.mockResolvedValue([]);
    mocks.operations.mockResolvedValue({ workers: [] });
  });
  it('requires platform admin before reading host and queue details', async () => {
    mocks.auth.mockRejectedValue(
      new DataAccessError('authentication_required'),
    );
    expect((await GET(request())).status).toBe(401);
    expect(mocks.operations).not.toHaveBeenCalled();
  });
  it('does not cache host facts and keeps employee inventory usable if telemetry fails', async () => {
    expect((await GET(request())).headers.get('cache-control')).toBe(
      'private, no-store',
    );
    mocks.operations.mockRejectedValue(Error('synthetic-private-database-url'));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      operations: null,
      tenants: [],
      runtimes: [],
    });
  });
});
