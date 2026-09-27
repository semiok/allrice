import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
import { GET } from './route';
const ports = vi.hoisted(() => ({ context: vi.fn(), list: vi.fn() }));
vi.mock('../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listImageOperations: ports.list,
}));
beforeEach(() => {
  vi.resetAllMocks();
});
describe('platform image receipts', () => {
  it('denies tenant-only callers before reading cross-tenant image records', async () => {
    ports.context.mockRejectedValue(
      new DataAccessError('authorization_denied'),
    );
    expect((await GET(new Request('https://example.test/api'))).status).toBe(
      403,
    );
    expect(ports.list).not.toHaveBeenCalled();
  });
  it('does not cache administrator receipts or replace unknown usage with zero', async () => {
    ports.context.mockResolvedValue({ actor: { type: 'user', id: 'admin' } });
    ports.list.mockResolvedValue([{ status: 'unknown', usage: null }]);
    const response = await GET(new Request('https://example.test/api'));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      operations: [{ status: 'unknown', usage: null }],
    });
  });
});
