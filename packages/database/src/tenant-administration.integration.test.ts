import { canAdministerEmployees } from './employees/employeehub.ts';
import { createInvitation } from './identity.ts';
import { readFile } from 'node:fs/promises';
import { decideConnectorApproval } from './capabilities/connector-broker.ts';
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
  it('makes tenant users equal while platform authority works with a member membership', async () => {
    const t = await setup();
    expect(t.admin.context.memberships.every((m) => m.role === 'member')).toBe(
      true,
    );
    expect(
      await canAdministerEmployees(t.admin.context, t.admin.workspaceId),
    ).toBe(true);
    for (const role of ['member', 'admin'] as const) {
      await fixture.db`update allrice_memberships set role=${role} where id=${t.row.id}`;
      const context = (await authenticateSession(t.tenant.session.token, {
        organizationId: t.tenant.organizationId,
        workspaceId: t.tenant.workspaceId,
      }))!;
      expect(await canAdministerEmployees(context, t.tenant.workspaceId)).toBe(
        false,
      );
      await expect(
        createInvitation(context, {
          email: 'new-tenant-user@example.test',
          workspaceId: t.tenant.workspaceId,
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }
    const row = (await t.list()).members[0]!;
    const result = await t.change({
      role: undefined,
      expectedVersion: row.version,
    });
    expect(result.member.role).toBe('member');
    const readonly = await t.change({
      role: 'viewer',
      expectedVersion: result.member.version,
    });
    expect(
      (
        await t.change({
          role: undefined,
          active: false,
          expectedVersion: readonly.member.version,
        })
      ).member.role,
    ).toBe('viewer');
  });
  it('denies peer approvals to both current and historical tenant users', async () => {
    const t = await setup(),
      peer = await principal();
    await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${t.tenant.organizationId},${t.tenant.workspaceId},${peer.user.id},'admin')`;
    const context = (await authenticateSession(peer.session.token, {
      organizationId: t.tenant.organizationId,
      workspaceId: t.tenant.workspaceId,
    }))!;
    const run = randomUUID(),
      approval = randomUUID();
    await fixture.db`insert into allrice_runs(id,organization_id,workspace_id,owner_id,state,execution_spec,input) values(${run},${t.tenant.organizationId},${t.tenant.workspaceId},${t.tenant.user.id},'running','{}','{}')`;
    await fixture.db`insert into allrice_approval_requests(id,organization_id,workspace_id,run_id,actor_id,resource_type,resource_id,action,input_digest) values(${approval},${t.tenant.organizationId},${t.tenant.workspaceId},${run},${t.tenant.user.id},'connector_call',${randomUUID()},'connector.call',${'sha256:' + 'a'.repeat(64)})`;
    const input = {
      workspaceId: t.tenant.workspaceId,
      decision: 'approved',
      reason: 'Synthetic approval',
    };
    for (const role of ['admin', 'member']) {
      await fixture.db`update allrice_memberships set role=${role} where user_id=${peer.user.id}`;
      await expect(
        decideConnectorApproval(context, approval, input),
      ).rejects.toMatchObject({ code: 'authorization_denied' });
    }
    expect(
      (
        await fixture.db`select status from allrice_approval_requests where id=${approval}`
      )[0]!.status,
    ).toBe('pending');
    expect(
      await decideConnectorApproval(t.tenant.context, approval, input),
    ).toMatchObject({ status: 'approved' });
  });
  it('migrates old administrators without changing read-only access, scope, ownership or stored policy snapshots', async () => {
    const t = await setup(),
      peer = await principal();
    await fixture.db`update allrice_memberships set role='admin',active=false where id=${t.row.id}`;
    await fixture.db`insert into allrice_memberships(organization_id,workspace_id,user_id,role) values(${t.tenant.organizationId},${t.tenant.workspaceId},${peer.user.id},'viewer')`;
    const policyId = randomUUID(),
      invitationId = randomUUID();
    const payload = {
      memberships: [{ role: 'admin', userId: t.tenant.user.id }],
      grants: [],
    };
    await fixture.db`insert into allrice_policy_snapshots(id,organization_id,subject_id,version,payload,expires_at) values(${policyId},${t.tenant.organizationId},${t.tenant.user.id},1,${fixture.db.json(payload)},clock_timestamp()+interval '1 hour')`;
    await fixture.db`insert into allrice_invitations(id,organization_id,workspace_id,email,role,token_hash,expires_at) values(${invitationId},${t.tenant.organizationId},${t.tenant.workspaceId},'pending@example.test','admin',${'b'.repeat(64)},clock_timestamp()+interval '1 hour')`;
    const before =
      await fixture.db`select id,user_id,organization_id,workspace_id,active from allrice_memberships order by id`;
    const migration = await readFile(
      new URL('../migrations/0111_unified_tenant_users.sql', import.meta.url),
      'utf8',
    );
    await fixture.db.unsafe(migration);
    await fixture.db.unsafe(migration);
    expect(
      (
        await fixture.db`select payload from allrice_policy_snapshots where id=${policyId}`
      )[0]!.payload,
    ).toEqual(payload);
    expect(
      (
        await fixture.db`select role from allrice_invitations where id=${invitationId}`
      )[0]!.role,
    ).toBe('member');
    expect(
      await fixture.db`select id,user_id,organization_id,workspace_id,active from allrice_memberships order by id`,
    ).toEqual(before);
    expect(
      (await t.list()).members.find((m) => m.id === t.row.id),
    ).toMatchObject({ role: 'member', active: false });
    expect(
      (await t.list()).members.find((m) => m.userId === peer.user.id),
    ).toMatchObject({ role: 'viewer', active: true });
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
      t.change({ active: false }),
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
  it('normalizes all historical tenant admins and permits retiring the last workspace admin', async () => {
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
    expect(changes.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect((await t.list()).members.every((m) => m.role === 'member')).toBe(
      true,
    );
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
    ).resolves.toMatchObject({ member: { role: 'member' }, changed: true });
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
