import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { DataAccessError, RuntimePolicyError } from '@allrice/database';
import type * as Database from '@allrice/database';
const mocks = vi.hoisted(() => ({ context: vi.fn(), list: vi.fn() }));
vi.mock('../../../../../lib/identity/session', () => ({
  requireRequestContext: mocks.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listBrowserControlManagement: mocks.list,
}));
import { GET } from './route';
const workspace = randomUUID(),
  org = randomUUID(),
  actor = { type: 'user', id: randomUUID() },
  request = () =>
    new Request(
      `https://allrice.test/api/v1/admin/browser-control?workspaceId=${workspace}`,
    );
describe('browser grant management reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.context.mockResolvedValue({
      organizationId: org,
      actor,
      workspaceId: null,
    });
    mocks.list.mockResolvedValue({ targets: [], members: [], grants: [] });
  });
  it('passes real actor and selected workspace into live admin authority, without provisioning', async () => {
    const r = await GET(request());
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        actor,
        organizationId: org,
        workspaceId: workspace,
      }),
    );
  });
  it('denies missing auth, scope denial and unavailable DB without echoing errors', async () => {
    mocks.context.mockRejectedValueOnce(
      new DataAccessError('authentication_required'),
    );
    expect((await GET(request())).status).toBe(401);
    mocks.list.mockRejectedValueOnce(
      new RuntimePolicyError('membership_denied'),
    );
    expect((await GET(request())).status).toBe(403);
    mocks.list.mockRejectedValueOnce(Error('synthetic-secret'));
    const r = await GET(request());
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain('synthetic-secret');
  });
});
