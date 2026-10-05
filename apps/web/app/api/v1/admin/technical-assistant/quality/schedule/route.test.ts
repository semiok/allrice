import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  read: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('../../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getPlatformQualitySchedule: mocks.read,
  updatePlatformQualitySchedule: mocks.update,
  deletePlatformQualitySchedule: mocks.remove,
}));
import { GET, PUT, DELETE } from './route';
const url =
  'https://admin.allrice.test/api/v1/admin/technical-assistant/quality/schedule';
const writeRequest = (
  method: string,
  body: string,
  origin = 'https://admin.allrice.test',
) => new Request(url, { method, headers: { origin }, body });
describe('private quality schedule HTTP boundary', () => {
  beforeEach(() => vi.clearAllMocks());
  it('denies ordinary accounts for reads and both writes before accessing rules', async () => {
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await PUT(writeRequest('PUT', '{}'))).status).toBe(403);
    expect((await DELETE(writeRequest('DELETE', '{}'))).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it('blocks foreign origins and oversized writes before mutation', async () => {
    expect(
      (await PUT(writeRequest('PUT', '{}', 'https://other.test'))).status,
    ).toBe(403);
    expect(
      (await DELETE(writeRequest('DELETE', '{}', 'https://other.test'))).status,
    ).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValue({
      actor: { type: 'user', id: 'actual-owner' },
    });
    expect((await PUT(writeRequest('PUT', 'x'.repeat(1001)))).status).toBe(413);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('forwards only the real context, validates canonical responses and disables shared caching', async () => {
    const context = { actor: { type: 'user', id: 'actual-owner' } },
      view = { schedule: null, occurrences: [] };
    mocks.auth.mockResolvedValue(context);
    mocks.read.mockResolvedValue(view);
    mocks.update.mockResolvedValue(view);
    mocks.remove.mockResolvedValue(view);
    const input = { expectedRevision: 0, enabled: true, time: '09:00' };
    const response = await PUT(writeRequest('PUT', JSON.stringify(input)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.update).toHaveBeenCalledWith(context, input);
    expect(await response.json()).toEqual(view);
    expect(
      (await DELETE(writeRequest('DELETE', '{"expectedRevision":1}'))).status,
    ).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith(context, { expectedRevision: 1 });
    expect((await GET(new Request(url))).status).toBe(200);
  });
});
