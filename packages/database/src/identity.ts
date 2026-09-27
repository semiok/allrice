import { isPlatformAdmin } from './platform-authority.ts';
import type postgres from 'postgres';
import {
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
  createHash,
} from 'node:crypto';

import {
  AcceptInvitationInputSchema,
  CreateInvitationInputSchema,
  EmailSchema,
  LoginInputSchema,
  PasswordSchema,
  UsernameSchema,
  ChangePasswordInputSchema,
  UuidSchema,
  type Membership,
  type RequestContext,
  type Role,
} from '@allrice/contracts';

import { getDatabase } from './core/client.ts';
import {
  synchronizeTenantMembershipAccess,
  lockTenantEmployeeWorkspaces,
} from './tenant-employee-access.ts';

const passwordParameters = { N: 16_384, r: 8, p: 1 } as const;
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  username: string | null;
  email: string;
  display_name: string;
  password_hash: string;
  status: 'invited' | 'active' | 'disabled';
}

interface InvitationRow {
  id: string;
  organization_id: string;
  workspace_id: string | null;
  email: string;
  role: Role;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  status: UserRow['status'];
}

interface MembershipRow {
  id: string;
  user_id: string;
  organization_id: string;
  workspace_id: string | null;
  role: Role;
  active: boolean;
}

export class IdentityError extends Error {
  constructor(
    public readonly code:
      | 'authentication_failed'
      | 'authorization_denied'
      | 'portal_account_mismatch'
      | 'invitation_invalid'
      | 'tenant_context_invalid',
  ) {
    super(code);
  }
}

function derivePassword(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, passwordParameters, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

export async function hashPassword(password: string) {
  const parsed = PasswordSchema.parse(password);
  const salt = randomBytes(16);
  const derived = await derivePassword(parsed, salt);
  return [
    'scrypt',
    passwordParameters.N,
    passwordParameters.r,
    passwordParameters.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    !n ||
    !r ||
    !p ||
    !saltValue ||
    !hashValue ||
    Number(n) !== passwordParameters.N ||
    Number(r) !== passwordParameters.r ||
    Number(p) !== passwordParameters.p
  ) {
    return false;
  }
  const expected = Buffer.from(hashValue, 'base64url');
  const actual = await derivePassword(
    PasswordSchema.parse(password),
    Buffer.from(saltValue, 'base64url'),
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashOpaqueToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function makeOpaqueToken() {
  return randomBytes(32).toString('base64url');
}

async function recordAudit(input: {
  organizationId: string;
  workspaceId: string | null;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  decision: 'allowed' | 'denied' | 'recorded';
  reason: string;
  requestId: string | null;
}) {
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id
    ) values (
      ${input.organizationId}, ${input.workspaceId}, ${input.actorId},
      ${input.action}, ${input.resourceType}, ${input.resourceId},
      ${input.decision}, ${input.reason}, ${input.requestId}
    )
  `;
}

export async function bootstrapOrganization(input: {
  organizationSlug: string;
  organizationName: string;
  workspaceSlug: string;
  workspaceName: string;
  adminEmail: string;
  expiresAt: string;
}) {
  const email = EmailSchema.parse(input.adminEmail);
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new Error('expiresAt must be a future timestamp');
  }
  const token = makeOpaqueToken();
  const sql = getDatabase();
  const result = await sql.begin(async (transaction) => {
    const organizations = await transaction<{ id: string }[]>`
      insert into allrice_organizations (slug, name)
      values (${input.organizationSlug}, ${input.organizationName})
      on conflict (slug) do update set name = excluded.name
      returning id
    `;
    const organization = organizations[0];
    if (!organization) throw new Error('organization bootstrap failed');
    const workspaces = await transaction<{ id: string }[]>`
      insert into allrice_workspaces (organization_id, slug, name)
      values (${organization.id}, ${input.workspaceSlug}, ${input.workspaceName})
      on conflict (organization_id, slug) do update set name = excluded.name
      returning id
    `;
    const workspace = workspaces[0];
    if (!workspace) throw new Error('workspace bootstrap failed');
    const invitations = await transaction<{ id: string }[]>`
      insert into allrice_invitations (
        organization_id, workspace_id, email, role, token_hash, expires_at
      ) values (
        ${organization.id}, null, ${email}, 'member',
        ${hashOpaqueToken(token)}, ${expiresAt}
      )
      returning id
    `;
    const invitation = invitations[0];
    if (!invitation) throw new Error('invitation bootstrap failed');
    return {
      organizationId: organization.id,
      workspaceId: workspace.id,
      invitationId: invitation.id,
    };
  });
  return { ...result, token, expiresAt: expiresAt.toISOString() };
}

export async function createInvitation(
  context: RequestContext,
  input: unknown,
) {
  const invitation = CreateInvitationInputSchema.parse(input);
  const actorId = context.actor.type === 'user' ? context.actor.id : null;
  const admin = await isPlatformAdmin(context);
  if (!actorId || !admin) {
    await recordAudit({
      organizationId: context.organizationId,
      workspaceId: invitation.workspaceId,
      actorId,
      action: 'invitation.create',
      resourceType: 'invitation',
      resourceId: null,
      decision: 'denied',
      reason: 'platform_admin_required',
      requestId: context.requestId,
    });
    throw new IdentityError('authorization_denied');
  }
  if (Date.parse(invitation.expiresAt) <= Date.now()) {
    throw new IdentityError('invitation_invalid');
  }
  const sql = getDatabase();
  if (invitation.workspaceId) {
    const workspaces = await sql<{ id: string }[]>`
      select id from allrice_workspaces
      where id = ${invitation.workspaceId}
        and organization_id = ${context.organizationId}
        and archived_at is null
    `;
    if (!workspaces[0]) throw new IdentityError('tenant_context_invalid');
  }
  const token = makeOpaqueToken();
  const rows = await sql<{ id: string }[]>`
    insert into allrice_invitations (
      organization_id, workspace_id, email, role, token_hash,
      created_by, expires_at
    ) values (
      ${context.organizationId}, ${invitation.workspaceId},
      ${invitation.email}, ${invitation.role === 'admin' ? 'member' : invitation.role}, ${hashOpaqueToken(token)},
      ${actorId}, ${invitation.expiresAt}
    )
    returning id
  `;
  const row = rows[0];
  if (!row) throw new Error('invitation creation failed');
  await recordAudit({
    organizationId: context.organizationId,
    workspaceId: invitation.workspaceId,
    actorId,
    action: 'invitation.create',
    resourceType: 'invitation',
    resourceId: row.id,
    decision: 'allowed',
    reason: 'platform_admin',
    requestId: context.requestId,
  });
  return { id: row.id, token, expiresAt: invitation.expiresAt };
}

export async function acceptInvitation(input: unknown) {
  const accepted = AcceptInvitationInputSchema.parse(input);
  const passwordHash = await hashPassword(accepted.password);
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const invitations = await transaction<InvitationRow[]>`
      select id, organization_id, workspace_id, email, role, expires_at,
             accepted_at, revoked_at
      from allrice_invitations
      where token_hash = ${hashOpaqueToken(accepted.token)}
      for update
    `;
    const invitation = invitations[0];
    if (
      !invitation ||
      invitation.accepted_at ||
      invitation.revoked_at ||
      invitation.expires_at <= new Date()
    ) {
      throw new IdentityError('invitation_invalid');
    }
    const existing = await transaction<UserRow[]>`
      select id, email, display_name, password_hash, status
      from allrice_users where email = ${invitation.email}
    `;
    let user = existing[0];
    if (!user) {
      const users = await transaction<UserRow[]>`
        insert into allrice_users (email, display_name, password_hash, status)
        values (${invitation.email}, ${accepted.displayName}, ${passwordHash}, 'active')
        returning id, email, display_name, password_hash, status
      `;
      user = users[0];
    }
    if (!user || user.status === 'disabled') {
      throw new IdentityError('invitation_invalid');
    }
    await lockTenantEmployeeWorkspaces(transaction, {
      organizationId: invitation.organization_id,
      workspaceId: invitation.workspace_id,
    });
    await transaction`
      insert into allrice_memberships (
        organization_id, workspace_id, user_id, role, active
      ) values (
        ${invitation.organization_id}, ${invitation.workspace_id},
        ${user.id}, ${invitation.role === 'admin' ? 'member' : invitation.role}, true
      )
      on conflict (organization_id, workspace_id, user_id)
      do update set role = excluded.role, active = true, updated_at = now()
    `;
    await synchronizeTenantMembershipAccess(transaction, {
      organizationId: invitation.organization_id,
      workspaceId: invitation.workspace_id,
    });
    await transaction`
      update allrice_invitations set accepted_at = now() where id = ${invitation.id}
    `;
    return { id: user.id, email: user.email, displayName: user.display_name };
  });
}

async function insertSession(sql: postgres.TransactionSql, userId: string) {
  const parsedUserId = UuidSchema.parse(userId);
  const token = makeOpaqueToken();
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  const rows = await sql<{ id: string }[]>`
    insert into allrice_sessions (user_id, token_hash, expires_at)
    values (${parsedUserId}, ${hashOpaqueToken(token)}, ${expiresAt})
    returning id
  `;
  const session = rows[0];
  if (!session) throw new Error('session creation failed');
  return { id: session.id, token, expiresAt: expiresAt.toISOString() };
}

export async function createSession(userId: string) {
  return getDatabase().begin(async (transaction) => {
    const [user] = await transaction<UserRow[]>`
      select id, status from allrice_users where id=${UuidSchema.parse(userId)} for update`;
    if (user?.status !== 'active')
      throw new IdentityError('authentication_failed');
    return insertSession(transaction, user.id);
  });
}

/**
 * Provisions the deliberately small, deployment-owned principals used by the
 * temporary multi-domain portal. This is not a public sign-up path: callers
 * must authenticate the bootstrap credential before invoking it, and neither
 * the credential nor its hash is stored in the AllRice identity tables.
 *
 * The function is intentionally idempotent so a fresh development deployment
 * can materialize the platform and tenant boundaries from trusted server
 * configuration without invitation links.
 */
export async function ensureBootstrapPortalPrincipal(
  input: {
    organizationSlug: string;
    organizationName: string;
    workspaceSlug: string;
    workspaceName: string;
    email: string;
    displayName: string;
    role: Role;
  },
  sql = getDatabase(),
) {
  const email = EmailSchema.parse(input.email);
  const passwordHash = await hashPassword(
    randomBytes(32).toString('base64url'),
  );
  return sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtext(${`portal-principal:${email}`}))`;
    const organizations = await transaction<{ id: string }[]>`
      insert into allrice_organizations (slug, name)
      values (${input.organizationSlug}, ${input.organizationName})
      on conflict (slug) do nothing
      returning id
    `;
    const [organization] = await transaction<{ id: string }[]>`
      select id from allrice_organizations where slug=${input.organizationSlug} and archived_at is null`;
    if (!organization) throw new IdentityError('authorization_denied');

    await transaction<{ id: string }[]>`
      insert into allrice_workspaces (organization_id, slug, name)
      values (${organization.id}, ${input.workspaceSlug}, ${input.workspaceName})
      on conflict (organization_id, slug) do nothing
      returning id
    `;
    const [workspace] = await transaction<{ id: string }[]>`
      select id from allrice_workspaces where organization_id=${organization.id}
        and slug=${input.workspaceSlug} and archived_at is null`;
    if (!workspace) throw new IdentityError('authorization_denied');

    const existingUsers = await transaction<UserRow[]>`
      select id, email, display_name, password_hash, status
      from allrice_users where email = ${email}
      for share
    `;
    let user = existingUsers[0];
    if (!user) {
      const users = await transaction<UserRow[]>`
        insert into allrice_users (email, display_name, password_hash, status)
        values (${email}, ${input.displayName}, ${passwordHash}, 'active')
        returning id, email, display_name, password_hash, status
      `;
      user = users[0];
    } else if (user.status !== 'active')
      throw new IdentityError('authentication_failed');
    if (!user) throw new Error('portal user provisioning failed');

    // Provision only a new principal / new tenant. Existing member removal,
    // deactivation and role changes are authoritative, including across login.
    if (!existingUsers.length || organizations.length)
      await transaction`
      insert into allrice_memberships (
        organization_id, workspace_id, user_id, role, active
      ) values (
        ${organization.id}, null, ${user.id}, ${input.role === 'admin' ? 'member' : input.role}, true
      )
      on conflict (organization_id, workspace_id, user_id)
      do nothing
    `;

    const [membership] = await transaction`
      select id from allrice_memberships where organization_id=${organization.id}
        and user_id=${user.id} and active
        and (workspace_id is null or workspace_id=${workspace.id}) limit 1`;
    if (!membership) throw new IdentityError('authorization_denied');
    // Only bootstrap events provision inheritance; repeat login is not a grant writer.
    if (!existingUsers.length || organizations.length)
      await synchronizeTenantMembershipAccess(transaction, {
        organizationId: organization.id,
        workspaceId: null,
      });

    return {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
      },
      organizationId: organization.id,
      workspaceId: workspace.id,
    };
  });
}

export async function login(
  input: unknown,
  expectedEmail?: string,
  expectedAccountKind?: 'employee' | 'platform_admin',
) {
  const credentials = LoginInputSchema.parse(input);
  return getDatabase().begin(async (transaction) => {
    // Password verification and session creation serialize with password reset.
    const [user] = await transaction<UserRow[]>`
      select id, username, email, display_name, password_hash, status
      from allrice_users
      where (${credentials.username ?? null}::text is not null and username=${credentials.username ?? null})
         or (${credentials.email ?? null}::text is not null and lower(email)=${credentials.email ?? null})
      for update`;
    if (
      !user ||
      user.status !== 'active' ||
      (expectedEmail &&
        user.email.toLowerCase() !== EmailSchema.parse(expectedEmail)) ||
      !(await verifyPassword(credentials.password, user.password_hash))
    )
      throw new IdentityError('authentication_failed');
    const [membership] = await transaction`
      select m.id from allrice_memberships m
      join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
      where m.user_id=${user.id} and m.active
      and (m.workspace_id is null or exists (select 1 from allrice_workspaces w
        where w.id=m.workspace_id and w.archived_at is null)) limit 1`;
    if (!membership) throw new IdentityError('authorization_denied');
    if (expectedAccountKind) {
      const admin = await isPlatformAdmin(
        { actor: { type: 'user', id: user.id } },
        transaction,
      );
      if (admin !== (expectedAccountKind === 'platform_admin'))
        throw new IdentityError('portal_account_mismatch');
    }
    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
      },
      session: await insertSession(transaction, user.id),
    };
  });
}

/** Trusted bootstrap/migration only. Re-running never resets an existing login. */
export async function initializeAccountLogin(input: {
  userId: string;
  username: string;
  password: string;
}) {
  const username = UsernameSchema.parse(input.username);
  const passwordHash = await hashPassword(input.password);
  return getDatabase().begin(async (transaction) => {
    const [user] = await transaction<UserRow[]>`
      select id, username, status from allrice_users where id=${UuidSchema.parse(input.userId)} for update`;
    if (user?.status !== 'active')
      throw new IdentityError('authentication_failed');
    if (user.username) return { username: user.username, initialized: false };
    await transaction`update allrice_users set username=${username}, password_hash=${passwordHash}, updated_at=now()
      where id=${user.id}`;
    await transaction`update allrice_sessions set revoked_at=now() where user_id=${user.id} and revoked_at is null`;
    return { username, initialized: true };
  });
}

/** Transitional portal lookup: membership remains authoritative after migration. */
export async function getLegacyPortalAccount(input: {
  email: string;
  organizationSlug: string;
  workspaceSlug: string;
}) {
  const [row] = await getDatabase()<
    {
      id: string;
      username: string | null;
      organization_id: string;
      workspace_id: string;
    }[]
  >`select u.id, u.username, o.id as organization_id, w.id as workspace_id
    from allrice_users u
    join allrice_memberships m on m.user_id=u.id and m.active
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    join allrice_workspaces w on w.organization_id=o.id and w.archived_at is null
      and (m.workspace_id is null or m.workspace_id=w.id)
    where lower(u.email)=${EmailSchema.parse(input.email)}
      and o.slug=${input.organizationSlug} and w.slug=${input.workspaceSlug} limit 1`;
  return row ?? null;
}

export async function changePassword(context: RequestContext, input: unknown) {
  const value = ChangePasswordInputSchema.parse(input);
  if (context.actor.type !== 'user')
    throw new IdentityError('authentication_failed');
  const userId = context.actor.id;
  const passwordHash = await hashPassword(value.newPassword);
  await getDatabase().begin(async (transaction) => {
    const [user] = await transaction<UserRow[]>`
      select id, password_hash, status from allrice_users where id=${userId} for update`;
    const [session] = await transaction`
      select id from allrice_sessions where id=${context.sessionId} and user_id=${userId}
        and revoked_at is null and expires_at>now()`;
    if (
      !session ||
      user?.status !== 'active' ||
      !(await verifyPassword(value.currentPassword, user.password_hash))
    )
      throw new IdentityError('authentication_failed');
    await transaction`update allrice_users set password_hash=${passwordHash}, updated_at=now() where id=${userId}`;
    await transaction`update allrice_sessions set revoked_at=now() where user_id=${userId} and revoked_at is null`;
  });
}

export async function authenticateSession(
  token: string,
  tenant: { organizationId?: string; workspaceId?: string } = {},
): Promise<RequestContext | null> {
  const sql = getDatabase();
  const sessions = await sql<SessionRow[]>`
    select s.id, s.user_id, s.created_at, s.expires_at, s.revoked_at, u.status
    from allrice_sessions s
    join allrice_users u on u.id = s.user_id
    where s.token_hash = ${hashOpaqueToken(token)}
      and s.revoked_at is null
      and s.expires_at > now()
      and u.status = 'active'
  `;
  const session = sessions[0];
  if (!session) return null;
  const memberships = await sql<MembershipRow[]>`
    select m.id, m.user_id, m.organization_id, m.workspace_id, m.role, m.active
    from allrice_memberships m
    join allrice_organizations o on o.id=m.organization_id and o.archived_at is null
    where m.user_id = ${session.user_id} and m.active = true
      and (m.workspace_id is null or exists (select 1 from allrice_workspaces w
        where w.id=m.workspace_id and w.archived_at is null))
    order by m.created_at, m.id
  `;
  const organizationId = tenant.organizationId
    ? UuidSchema.safeParse(tenant.organizationId)
    : undefined;
  if (organizationId && !organizationId.success) {
    if (memberships[0]) {
      await recordAudit({
        organizationId: memberships[0].organization_id,
        workspaceId: null,
        actorId: session.user_id,
        action: 'tenant_context.select',
        resourceType: 'organization',
        resourceId: null,
        decision: 'denied',
        reason: 'invalid_organization_id',
        requestId: null,
      });
    }
    throw new IdentityError('tenant_context_invalid');
  }
  const selectedOrganization =
    organizationId?.data ?? memberships[0]?.organization_id;
  if (
    !selectedOrganization ||
    !memberships.some(
      (membership) => membership.organization_id === selectedOrganization,
    )
  ) {
    if (memberships[0]) {
      await recordAudit({
        organizationId: memberships[0].organization_id,
        workspaceId: null,
        actorId: session.user_id,
        action: 'tenant_context.select',
        resourceType: 'organization',
        resourceId: organizationId?.data ?? null,
        decision: 'denied',
        reason: 'organization_membership_missing',
        requestId: null,
      });
    }
    throw new IdentityError('tenant_context_invalid');
  }
  let selectedWorkspace: string | null = null;
  if (tenant.workspaceId) {
    const workspaceId = UuidSchema.safeParse(tenant.workspaceId);
    if (!workspaceId.success) {
      await recordAudit({
        organizationId: selectedOrganization,
        workspaceId: null,
        actorId: session.user_id,
        action: 'tenant_context.select',
        resourceType: 'workspace',
        resourceId: null,
        decision: 'denied',
        reason: 'invalid_workspace_id',
        requestId: null,
      });
      throw new IdentityError('tenant_context_invalid');
    }
    const workspaces = await sql<{ id: string }[]>`
      select id from allrice_workspaces
      where id = ${workspaceId.data}
        and organization_id = ${selectedOrganization}
        and archived_at is null
    `;
    const permitted = memberships.some(
      (membership) =>
        membership.organization_id === selectedOrganization &&
        (membership.workspace_id === null ||
          membership.workspace_id === workspaceId.data),
    );
    if (!workspaces[0] || !permitted) {
      await recordAudit({
        organizationId: selectedOrganization,
        workspaceId: null,
        actorId: session.user_id,
        action: 'tenant_context.select',
        resourceType: 'workspace',
        resourceId: workspaceId.data,
        decision: 'denied',
        reason: 'workspace_membership_missing',
        requestId: null,
      });
      throw new IdentityError('tenant_context_invalid');
    }
    selectedWorkspace = workspaceId.data;
  }
  await sql`
    update allrice_sessions set last_seen_at = now() where id = ${session.id}
  `;
  const contractMemberships: Membership[] = memberships.map((membership) => ({
    id: membership.id,
    userId: membership.user_id,
    organizationId: membership.organization_id,
    workspaceId: membership.workspace_id,
    role: membership.role,
    active: membership.active,
  }));
  return {
    requestId: randomUUID(),
    sessionId: session.id,
    actor: { type: 'user', id: session.user_id },
    organizationId: selectedOrganization,
    workspaceId: selectedWorkspace,
    memberships: contractMemberships,
    authenticatedAt: session.created_at.toISOString(),
  };
}

export async function revokeSession(token: string) {
  const sql = getDatabase();
  await sql`
    update allrice_sessions set revoked_at = now()
    where token_hash = ${hashOpaqueToken(token)} and revoked_at is null
  `;
}
