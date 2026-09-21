import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Database from '@allrice/database';
import { DataAccessError, TenantAdministrationError } from '@allrice/database';
import { tenantAdministrationHttp } from './http';
const ports = vi.hoisted(() => ({
  context: vi.fn(),
  list: vi.fn(),
  members: vi.fn(),
  update: vi.fn(),
}));
vi.mock('../identity/platform-admin', () => ({
  requirePlatformAdminContext: ports.context,
}));
vi.mock('@allrice/database', async (original) => ({
  ...(await original<typeof Database>()),
  listAdminTenants: ports.list,
  listAdminTenantMembers: ports.members,
  updateAdminTenantMember: ports.update,
}));
const request = (body?: unknown, origin = 'https://admin.example') =>
  new Request(
    'https://admin.example/api/v1/admin/tenants/tenant?workspaceId=workspace',
    {
      method: body === undefined ? 'GET' : 'PATCH',
      headers: { origin, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
beforeEach(() => {
  vi.resetAllMocks();
  ports.context.mockResolvedValue({ actor: { id: 'issuer' } });
  ports.list.mockResolvedValue({ tenants: [] });
  ports.members.mockResolvedValue({ members: [] });
  ports.update.mockResolvedValue({ changed: true });
});
describe('tenant administration HTTP boundary', () => {
  it('keeps the issuer context separate from the selected target', async () => {
    const response = await tenantAdministrationHttp(request(), 'tenant');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(ports.members).toHaveBeenCalledWith(
      { actor: { id: 'issuer' } },
      'tenant',
      'workspace',
      undefined,
    );
  });
  it.each([
    ['authentication_required', 401],
    ['authorization_denied', 403],
  ] as const)('rejects %s before reading or writing', async (code, status) => {
    ports.context.mockRejectedValue(new DataAccessError(code));
    expect(
      (
        await tenantAdministrationHttp(
          request({ role: 'admin' }),
          'tenant',
          'member',
        )
      ).status,
    ).toBe(status);
    expect(ports.update).not.toHaveBeenCalled();
    expect(ports.members).not.toHaveBeenCalled();
  });
  it('requires same-origin JSON for mutation and limits the body', async () => {
    expect(
      (
        await tenantAdministrationHttp(
          request({}, 'https://attacker.example'),
          'tenant',
          'member',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await tenantAdministrationHttp(
          request({ reason: 'x'.repeat(9000) }),
          'tenant',
          'member',
        )
      ).status,
    ).toBe(400);
    const missing = new Request('https://admin.example', {
      method: 'PATCH',
      body: '{}',
    });
    expect(
      (await tenantAdministrationHttp(missing, 'tenant', 'member')).status,
    ).toBe(403);
    expect(ports.update).not.toHaveBeenCalled();
  });
  it('passes one explicit update, returns a conflict without retry, and redacts unexpected failures', async () => {
    const data = { role: 'viewer', active: false, reason: 'Explicit scope' };
    expect(
      (await tenantAdministrationHttp(request(data), 'tenant', 'member'))
        .status,
    ).toBe(200);
    expect(ports.update).toHaveBeenCalledWith(
      { actor: { id: 'issuer' } },
      'tenant',
      'member',
      data,
    );
    ports.update.mockRejectedValueOnce(
      new TenantAdministrationError('member_conflict'),
    );
    expect(
      (await tenantAdministrationHttp(request(data), 'tenant', 'member'))
        .status,
    ).toBe(409);
    expect(ports.update).toHaveBeenCalledTimes(2);
    ports.update.mockRejectedValueOnce(Error('private database error'));
    const response = await tenantAdministrationHttp(
      request(data),
      'tenant',
      'member',
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private');
  });
});
