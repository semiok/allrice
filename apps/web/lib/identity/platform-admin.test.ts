import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { requirePlatformAdminContext } from './platform-admin';
const ports = vi.hoisted(() => ({ context: vi.fn(), admin: vi.fn() }));
vi.mock('./session', () => ({ getRequestContext: ports.context }));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  isPlatformAdmin: ports.admin,
}));
beforeEach(() => vi.resetAllMocks());
describe('platform authorization', () => {
  it('requires an authenticated user', async () => {
    ports.context.mockResolvedValue(null);
    await expect(
      requirePlatformAdminContext(new Request('https://admin.example')),
    ).rejects.toMatchObject({ code: 'authentication_required' });
    expect(ports.admin).not.toHaveBeenCalled();
  });
  it('does not promote a tenant admin to platform admin', async () => {
    ports.context.mockResolvedValue({
      actor: { type: 'user', id: 'tenant-user' },
      memberships: [{ active: true, role: 'admin' }],
    });
    ports.admin.mockResolvedValue(false);
    await expect(
      requirePlatformAdminContext(new Request('https://admin.example')),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('uses the server-backed platform entitlement without forging a target tenant membership', async () => {
    const context = {
      actor: { type: 'user', id: 'platform-user' },
      memberships: [],
    };
    ports.context.mockResolvedValue(context);
    ports.admin.mockResolvedValue(true);
    expect(
      await requirePlatformAdminContext(new Request('https://admin.example')),
    ).toBe(context);
    expect(ports.admin).toHaveBeenCalledWith(context);
  });
});
