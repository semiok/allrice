import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import * as client from './core/client.ts';
import { createAssistantFixtureDatabase } from './assistant-runtime.fixture.ts';
import {
  authenticateSession,
  createSession,
  ensureBootstrapPortalPrincipal,
  revokeSession,
} from './identity.ts';
import {
  listAdminTenants,
  listAdminTenantMembers,
  updateAdminTenantMember,
} from './tenant-administration.ts';

const integration =
  process.env.ALLRICE_RUN_DB_INTEGRATION === '1'
    ? describe.sequential
    : describe.skip;
integration('MET-151 tenant administration (isolated PostgreSQL)', () => {
  let fixture: Awaited<ReturnType<typeof createAssistantFixtureDatabase>>;
  beforeAll(async () => {
    fixture = await createAssistantFixtureDatabase();
    vi.spyOn(client, 'getDatabase').mockReturnValue(fixture.db);
  }, 120000);
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (fixture) await fixture.close();
  });
  async function principal(role: 'admin' | 'member' = 'member') {
    const slug = `t-${randomUUID()}`;
    const input = {
      organizationSlug: slug,
      organizationName: 'Synthetic tenant',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: `${slug}@example.test`,
      displayName: 'Synthetic member',
      role,
    };
    const p = await ensureBootstrapPortalPrincipal(input, fixture.db),
      session = await createSession(p.user.id);
    const context = await authenticateSession(session.token, {
      organizationId: p.organizationId,
      workspaceId: p.workspaceId,
    });
    if (!context) throw Error('fixture_login');
    return { input, ...p, session, context };
  }
  async function setup() {
    const admin = await principal('admin'),
      tenant = await principal();
    vi.stubEnv('ALLRICE_PLATFORM_ADMIN_EMAILS', admin.user.email);
    const list = () =>
      listAdminTenantMembers(
        admin.context,
        tenant.organizationId,
        null,
        undefined,
        fixture.db,
      );
    const row = (await list()).members[0]!;
    const change = (
      value: Partial<{
        role: 'admin' | 'member' | 'viewer';
        active: boolean;
        expectedVersion: string;
        workspaceId: string | null;
      }> = {},
    ) =>
      updateAdminTenantMember(
        admin.context,
        tenant.organizationId,
        row.id,
        {
          workspaceId: row.workspaceId,
          expectedVersion: row.version,
          role: 'viewer',
          active: true,
          reason: 'Synthetic member role review',
          ...value,
        },
        fixture.db,
      );
    return { admin, tenant, list, row, change };
  }
  it('allows platform admin to manage another tenant without impersonation or membership creation; audits actual actor', async () => {
    const t = await setup();
    const result = await t.change();
    expect(result.member.role).toBe('viewer');
    expect((await t.list()).members[0]!.version).not.toBe(t.row.version);
    const [audit] =
      await fixture.db`select actor_id,organization_id,metadata from allrice_audit_events where resource_id=${t.row.id} and action='tenant.member.updated'`;
    expect(audit).toMatchObject({
      actor_id: t.admin.user.id,
      organization_id: t.tenant.organizationId,
      metadata: {
        targetUserId: t.tenant.user.id,
        before: { role: 'member' },
        after: { role: 'viewer' },
        deviceAuthorizationChanged: false,
      },
    });
    expect(
      await fixture.db`select id from allrice_memberships where organization_id=${t.tenant.organizationId} and user_id=${t.admin.user.id}`,
    ).toHaveLength(0);
    await ensureBootstrapPortalPrincipal(t.tenant.input, fixture.db);
    expect((await t.list()).members[0]!.role).toBe('viewer');
    expect(
      (
        await listAdminTenants(t.admin.context, undefined, fixture.db)
      ).tenants.some((o) => o.id === t.tenant.organizationId),
    ).toBe(true);
  });
  it('does not trust tenant admin role, copied context claims, disabled users or expired/revoked sessions', async () => {
    const t = await setup();
    await fixture.db`update allrice_memberships set role='admin' where id=${t.row.id}`;
    const forged = {
      ...t.tenant.context,
      memberships: t.admin.context.memberships,
    };
    await expect(
      listAdminTenants(forged, undefined, fixture.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      listAdminTenants(
        { ...t.admin.context, actor: { type: 'worker', id: t.admin.user.id } },
        undefined,
        fixture.db,
      ),
    ).rejects.toMatchObject({ code: 'authentication_required' });
    await revokeSession(t.admin.session.token);
    await expect(t.list()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    await expect(t.change()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    const t2 = await setup();
    await fixture.db`update allrice_users set status='disabled' where id=${t2.admin.user.id}`;
    await expect(t2.list()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    const t3 = await setup();
    await fixture.db`update allrice_sessions set expires_at=now()-interval '1 second',created_at=now()-interval '1 day' where id=${t3.admin.session.id}`;
    await expect(t3.change()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
    const t4 = await setup();
    await fixture.db`update allrice_workspaces set archived_at=now() where id=${t4.admin.workspaceId}`;
    await expect(t4.change()).rejects.toMatchObject({
      code: 'authorization_denied',
    });
  });
  it('keeps disabled membership and deleted grants disabled across login; old sessions lose tenant access', async () => {
    const t = await setup();
    await t.change({ active: false, role: 'member' });
    await expect(
      ensureBootstrapPortalPrincipal(t.tenant.input, fixture.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    await expect(
      authenticateSession(t.tenant.session.token, {
        organizationId: t.tenant.organizationId,
        workspaceId: t.tenant.workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'tenant_context_invalid' });
    await fixture.db`delete from allrice_memberships where id=${t.row.id}`;
    await expect(
      ensureBootstrapPortalPrincipal(t.tenant.input, fixture.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
    expect(
      await fixture.db`select id from allrice_memberships where user_id=${t.tenant.user.id}`,
    ).toHaveLength(0);
  });
  it('does not reactivate disabled users, rename existing tenants, or reopen archived workspaces', async () => {
    const t = await setup();
    await fixture.db`update allrice_organizations set name='Managed name' where id=${t.tenant.organizationId}`;
    await ensureBootstrapPortalPrincipal(t.tenant.input, fixture.db);
    const [org] =
      await fixture.db`select name from allrice_organizations where id=${t.tenant.organizationId}`;
    expect(org!.name).toBe('Managed name');
    await fixture.db`update allrice_users set status='disabled' where id=${t.tenant.user.id}`;
    await expect(
      ensureBootstrapPortalPrincipal(t.tenant.input, fixture.db),
    ).rejects.toMatchObject({ code: 'authentication_failed' });
    expect(await authenticateSession(t.tenant.session.token)).toBeNull();
    const t2 = await setup();
    await fixture.db`update allrice_workspaces set archived_at=now() where id=${t2.tenant.workspaceId}`;
    await expect(
      ensureBootstrapPortalPrincipal(t2.tenant.input, fixture.db),
    ).rejects.toMatchObject({ code: 'authorization_denied' });
  });
  it('denies a foreign member ID, foreign workspace and mismatched membership scope without writes', async () => {
    const t = await setup(),
      other = await principal();
    await expect(
      updateAdminTenantMember(
        t.admin.context,
        other.organizationId,
        t.row.id,
        {
          workspaceId: null,
          expectedVersion: t.row.version,
          role: 'admin',
          active: true,
          reason: 'Synthetic wrong tenant',
        },
        fixture.db,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      listAdminTenantMembers(
        t.admin.context,
        t.tenant.organizationId,
        other.workspaceId,
        undefined,
        fixture.db,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      t.change({ workspaceId: t.tenant.workspaceId }),
    ).rejects.toMatchObject({ code: 'scope_mismatch' });
    expect((await t.list()).members[0]!.role).toBe('member');
  });
  it('uses an exact version token; concurrent edits have one winner and one audit', async () => {
    const t = await setup();
    const results = await Promise.allSettled([
      t.change({ role: 'viewer' }),
      t.change({ role: 'admin' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'member_conflict' },
    });
    expect(
      await fixture.db`select id from allrice_audit_events where resource_id=${t.row.id} and action='tenant.member.updated'`,
    ).toHaveLength(1);
  });
  it('restores a disabled grant through a new audited version without erasing history', async () => {
    const t = await setup();
    const disabled = await t.change({ active: false });
    const restored = await t.change({
      expectedVersion: disabled.member.version,
      role: 'member',
      active: true,
    });
    expect(restored.member).toMatchObject({ role: 'member', active: true });
    await ensureBootstrapPortalPrincipal(t.tenant.input, fixture.db);
    expect(
      await authenticateSession(t.tenant.session.token, {
        organizationId: t.tenant.organizationId,
        workspaceId: t.tenant.workspaceId,
      }),
    ).not.toBeNull();
    expect(
      await fixture.db`select id from allrice_audit_events where resource_id=${t.row.id} and action='tenant.member.updated'`,
    ).toHaveLength(2);
  });
  it('prevents concurrent removal of all organization admins and protects the final workspace admin', async () => {
    const t = await setup(),
      second = await principal();
    await fixture.db`update allrice_memberships set role='admin' where id=${t.row.id}`;
    await fixture.db`insert into allrice_memberships(organization_id,user_id,role) values(${t.tenant.organizationId},${second.user.id},'admin')`;
    const rows = (await t.list()).members;
    const changes = await Promise.allSettled(
      rows.map((row) =>
        updateAdminTenantMember(
          t.admin.context,
          t.tenant.organizationId,
          row.id,
          {
            workspaceId: null,
            expectedVersion: row.version,
            role: 'member',
            active: true,
            reason: 'Synthetic concurrent demotion',
          },
          fixture.db,
        ),
      ),
    );
    expect(changes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(changes.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'last_administrator' },
    });
    const t2 = await setup();
    await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${t2.tenant.organizationId},${t2.tenant.workspaceId},${second.user.id},'admin')`;
    const workspaceAdmin = (await t2.list()).members.find(
      (m) => m.workspaceId === t2.tenant.workspaceId,
    )!;
    await expect(
      updateAdminTenantMember(
        t2.admin.context,
        t2.tenant.organizationId,
        workspaceAdmin.id,
        {
          workspaceId: workspaceAdmin.workspaceId,
          expectedVersion: workspaceAdmin.version,
          role: 'member',
          active: true,
          reason: 'Synthetic final workspace admin',
        },
        fixture.db,
      ),
    ).rejects.toMatchObject({ code: 'last_administrator' });
  });
  it('makes initial concurrent portal provisioning idempotent without elevating an existing principal', async () => {
    const slug = `t-${randomUUID()}`;
    const input = {
      organizationSlug: slug,
      organizationName: 'First login',
      workspaceSlug: 'default',
      workspaceName: 'Default',
      email: `${slug}@example.test`,
      displayName: 'First user',
      role: 'member' as const,
    };
    const [a, b] = await Promise.all([
      ensureBootstrapPortalPrincipal(input, fixture.db),
      ensureBootstrapPortalPrincipal(input, fixture.db),
    ]);
    expect(a.user.id).toBe(b.user.id);
    await ensureBootstrapPortalPrincipal(
      { ...input, role: 'admin' },
      fixture.db,
    );
    const rows =
      await fixture.db`select role from allrice_memberships where user_id=${a.user.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('member');
  });
});
