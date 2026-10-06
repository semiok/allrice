import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, QueueError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../../../../../../lib/identity/platform-admin', () => ({
  requirePlatformAdminContext: mocks.auth,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getPlatformRepositoryCredential: mocks.get,
  updatePlatformRepositoryCredential: mocks.update,
}));
import { GET, PUT } from './route';
const endpoint =
  'https://admin.allrice.test/api/v1/admin/technical-assistant/repository-credential';
const write = (body: string, origin = 'https://admin.allrice.test') =>
  new Request(endpoint, {
    method: 'PUT',
    headers: { origin, 'content-type': 'application/json' },
    body,
  });
describe('platform repository credential API ingress and secret-free responses', () => {
  beforeEach(() => vi.resetAllMocks());
  it('rejects employee accounts and foreign browser writes before reading or storing credentials', async () => {
    mocks.auth.mockRejectedValue(new DataAccessError('authorization_denied'));
    expect((await GET(new Request(endpoint))).status).toBe(403);
    expect((await PUT(write('{}'))).status).toBe(403);
    expect((await PUT(write('{}', 'https://foreign.test'))).status).toBe(403);
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('bounds request bytes and refuses accidental credential fields in a public response', async () => {
    mocks.auth.mockResolvedValue({});
    expect((await PUT(write('a'.repeat(2049)))).status).toBe(413);
    expect(mocks.update).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({
      repositoryId: 1323769790,
      repository: 'semiok/allrice',
      revision: 0,
      configured: false,
      state: 'not_configured',
      updatedAt: null,
      lastWriteRequestId: null,
      token: 'SYNTHETIC_SECRET',
    });
    const response = await GET(new Request(endpoint));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('SYNTHETIC_SECRET');
  });
  it('preserves conflict and private no-store semantics', async () => {
    mocks.auth.mockResolvedValue({});
    mocks.update.mockRejectedValue(new QueueError('conflict'));
    expect((await PUT(write('{}'))).status).toBe(409);
    mocks.get.mockResolvedValue({
      repositoryId: 1323769790,
      repository: 'semiok/allrice',
      revision: 0,
      configured: false,
      state: 'not_configured',
      updatedAt: null,
      lastWriteRequestId: null,
    });
    expect(
      (await GET(new Request(endpoint))).headers.get('cache-control'),
    ).toBe('private, no-store');
  });
});
