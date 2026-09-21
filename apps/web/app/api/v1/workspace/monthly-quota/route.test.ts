import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({ context: vi.fn(), quota: vi.fn() }));
vi.mock('../../../../../lib/identity/session', () => ({
  getRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  getUserMonthlyQuota: mocks.quota,
}));
import { DataAccessError } from '@allrice/database';
import { GET } from './route';
const workspace = '00000000-0000-4000-8000-000000000001';
const context = { actor: { type: 'user', id: 'authenticated-user' } };
describe('current account monthly quota route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue(context);
  });
  it('requires login and a valid workspace', async () => {
    mocks.context.mockResolvedValue(null);
    expect((await GET(new Request('https://test/api'))).status).toBe(401);
    mocks.context.mockResolvedValue(context);
    expect(
      (await GET(new Request('https://test/api?workspaceId=bad'))).status,
    ).toBe(400);
    expect(mocks.quota).not.toHaveBeenCalled();
  });
  it('never accepts a client user/organization/limit override, and never caches the response', async () => {
    mocks.quota.mockResolvedValue({ remainingPercent: 43 });
    const response = await GET(
      new Request(
        `https://test/api?workspaceId=${workspace}&userId=other&organizationId=other&monthlyTokenLimit=90000000`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.quota).toHaveBeenCalledExactlyOnceWith(context, workspace);
  });
  it('denies foreign workspace reads', async () => {
    mocks.quota.mockRejectedValue(new DataAccessError('authorization_denied'));
    expect(
      (await GET(new Request(`https://test/api?workspaceId=${workspace}`)))
        .status,
    ).toBe(403);
  });
  it('returns unavailable rather than a false zero or leaking SQL', async () => {
    mocks.quota.mockRejectedValue(Error('postgres://private-secret'));
    const response = await GET(
      new Request(`https://test/api?workspaceId=${workspace}`),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'QUOTA_UNAVAILABLE' });
  });
});
