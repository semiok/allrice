import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  OrganizationInputSchema,
  OrganizationUpdateSchema,
  OrganizationImportSchema,
  OrganizationPersonUpdateSchema,
  OrganizationAccountStatusSchema,
  OrganizationPasswordResetSchema,
  UuidSchema,
  type ManagedOrganization,
  type OrganizationPerson,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { hashPassword } from './identity.ts';
import { isPlatformAdmin } from './platform-authority.ts';
import {
  listAdminTenants,
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';
import { synchronizeTenantMembershipAccess } from './tenant-employee-access.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
export class OrganizationAdministrationError extends Error {
  constructor(
    readonly code:
      | 'account_conflict'
      | 'username_taken'
      | 'email_taken'
      | 'reserved_username'
      | 'organization_conflict',
  ) {
    super(code);
  }
}
function checkUsername(username: string) {
  if (
    username ===
    (process.env.ALLRICE_PLATFORM_ADMIN_USER ?? 'admin').toLowerCase()
  )
    throw new OrganizationAdministrationError('reserved_username');
}
async function uniqueAccount<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505'
    ) {
      const constraint =
        'constraint_name' in error ? String(error.constraint_name) : '';
      if (constraint === 'allrice_users_username_unique')
        throw new OrganizationAdministrationError('username_taken');
      if (constraint === 'allrice_users_email_unique')
        throw new OrganizationAdministrationError('email_taken');
    }
    throw error;
  }
}
async function audit(
  tx: postgres.TransactionSql,
  context: RequestContext,
  organizationId: string,
  action: string,
  resourceId: string,
  metadata: Record<string, string | number | boolean> = {},
) {
  await tx`insert into allrice_audit_events (organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
    values (${organizationId},${context.actor.id},${action},'organization_account',${resourceId},'recorded',${action},${context.requestId},${tx.json(metadata)})`;
}

export async function listManagedOrganizations(
  context: RequestContext,
  cursor?: string,
) {
  const db = getDatabase();
  const base = await listAdminTenants(context, cursor, db);
  if (!base.tenants.length)
    return {
      organizations: [] as ManagedOrganization[],
      nextCursor: base.nextCursor,
    };
  const rows =
    await db`select o.id,o.business_context,o.revision,o.default_workspace_id,
    (select count(distinct m.user_id)::int from allrice_memberships m where m.organization_id=o.id) as people_count
    from allrice_organizations o where o.id in ${db(base.tenants.map((o) => o.id))}`;
  return {
    organizations: base.tenants.map((o) => {
      const row = rows.find((r) => r.id === o.id)!;
      return {
        ...o,
        businessContext: String(row.business_context),
        revision: Number(row.revision),
        defaultWorkspaceId: row.default_workspace_id as string | null,
        peopleCount: Number(row.people_count),
      };
    }) satisfies ManagedOrganization[],
    nextCursor: base.nextCursor,
  };
}

export async function createManagedOrganization(
  context: RequestContext,
  input: unknown,
) {
  const value = OrganizationInputSchema.parse(input);
  return getDatabase().begin(async (tx) => {
    await requireTenantAdministrationAuthority(context, tx);
    const id = randomUUID(),
      workspaceId = randomUUID();
    await tx`insert into allrice_organizations(id,slug,name,business_context,managed_employee_roster)
      values(${id},${`company-${id}`},${value.name},${value.businessContext},true)`;
    await tx`insert into allrice_workspaces(id,organization_id,slug,name) values(${workspaceId},${id},'default','默认工作区')`;
    await tx`update allrice_organizations set default_workspace_id=${workspaceId} where id=${id}`;
    await audit(tx, context, id, 'organization.created', id);
    return { organizationId: id, defaultWorkspaceId: workspaceId };
  });
}

export async function getManagedOrganization(
  context: RequestContext,
  idInput: string,
) {
  const id = UuidSchema.parse(idInput),
    db = getDatabase();
  await requireTenantAdministrationAuthority(context, db);
  await requireTenantAdministrationTarget(db, id, null);
  const [row] = await db`select o.*,
    (select count(distinct m.user_id)::int from allrice_memberships m where m.organization_id=o.id) as people_count
    from allrice_organizations o where o.id=${id}`;
  if (!row) throw new DataAccessError('not_found');
  const workspaces = await db<{ id: string; name: string; slug: string }[]>`
    select id,name,slug from allrice_workspaces where organization_id=${id} and archived_at is null order by name,id`;
  return {
    organization: {
      id,
      name: String(row.name),
      slug: String(row.slug),
      businessContext: String(row.business_context),
      revision: Number(row.revision),
      defaultWorkspaceId: row.default_workspace_id as string | null,
      workspaces: [...workspaces],
      peopleCount: Number(row.people_count),
    } satisfies ManagedOrganization,
  };
}

export async function updateManagedOrganization(
  context: RequestContext,
  idInput: string,
  input: unknown,
) {
  const id = UuidSchema.parse(idInput),
    value = OrganizationUpdateSchema.parse(input);
  return getDatabase().begin(async (tx) => {
    await requireTenantAdministrationAuthority(context, tx);
    await requireTenantAdministrationTarget(tx, id, null);
    const [row] =
      await tx`update allrice_organizations set name=${value.name},business_context=${value.businessContext},revision=revision+1
      where id=${id} and revision=${value.expectedRevision} returning revision`;
    if (!row)
      throw new OrganizationAdministrationError('organization_conflict');
    await audit(tx, context, id, 'organization.updated', id);
    return { revision: Number(row.revision) };
  });
}

async function peopleRows(
  db: Sql,
  organizationId: string,
  options: { userId?: string; after?: string; search?: string } = {},
) {
  const search = options.search?.trim().slice(0, 160) || null;
  return db`select u.id as user_id,u.username,u.email,u.status,
    coalesce(p.display_name,u.display_name) as display_name,coalesce(p.job_title,'') as job_title,coalesce(p.responsibilities,'') as responsibilities,
    exists(select 1 from allrice_memberships m where m.organization_id=${organizationId} and m.user_id=u.id and m.active) as membership_active,
    md5(coalesce(to_jsonb(p)::text,'{}') || coalesce(u.username,'') || u.status) as version
    from allrice_users u left join allrice_organization_people p on p.user_id=u.id and p.organization_id=${organizationId}
    where exists(select 1 from allrice_memberships m where m.user_id=u.id and m.organization_id=${organizationId})
      and (${options.userId ?? null}::uuid is null or u.id=${options.userId ?? null})
      and (${options.after ?? null}::uuid is null or u.id>${options.after ?? null})
      and (${search}::text is null or position(lower(${search}) in lower(coalesce(p.display_name,u.display_name)||' '||coalesce(u.username,'')||' '||coalesce(p.job_title,'')))>0)
    order by u.id limit 101`;
}
function person(row: Record<string, unknown>): OrganizationPerson {
  return {
    userId: String(row.user_id),
    username: row.username as string | null,
    displayName: String(row.display_name),
    jobTitle: String(row.job_title),
    responsibilities: String(row.responsibilities),
    email: String(row.email).endsWith('@users.allrice.invalid')
      ? null
      : String(row.email),
    status: row.status as OrganizationPerson['status'],
    membershipActive: Boolean(row.membership_active),
    version: String(row.version),
  };
}
export async function listOrganizationPeople(
  context: RequestContext,
  idInput: string,
  options: { after?: string; search?: string } = {},
) {
  const id = UuidSchema.parse(idInput),
    db = getDatabase();
  if (options.after) UuidSchema.parse(options.after);
  await requireTenantAdministrationAuthority(context, db);
  await requireTenantAdministrationTarget(db, id, null);
  const rows = await peopleRows(db, id, options);
  return {
    organizationId: id,
    people: rows.slice(0, 100).map(person),
    nextCursor: rows.length > 100 ? String(rows[99]!.user_id) : null,
  };
}

/** Atomic import: duplicate names never attach another account or reset its password. */
export async function importOrganizationPeople(
  context: RequestContext,
  idInput: string,
  input: unknown,
) {
  const id = UuidSchema.parse(idInput),
    value = OrganizationImportSchema.parse(input),
    db = getDatabase();
  await requireTenantAdministrationAuthority(context, db);
  value.people.forEach((p) => checkUsername(p.username));
  const prepared: ((typeof value.people)[number] & {
    id: string;
    hash: string;
  })[] = [];
  for (const p of value.people)
    prepared.push({
      ...p,
      id: randomUUID(),
      hash: await hashPassword(p.password),
    });
  return uniqueAccount(() =>
    db.begin(async (tx) => {
      await requireTenantAdministrationAuthority(context, tx);
      await requireTenantAdministrationTarget(tx, id, null);
      const [organization] =
        await tx`select id from allrice_organizations where id=${id} and archived_at is null for no key update`;
      if (!organization) throw new DataAccessError('not_found');
      for (const p of prepared) {
        await tx`insert into allrice_users(id,username,email,display_name,password_hash,status)
        values(${p.id},${p.username},${p.email ?? `account-${p.id}@users.allrice.invalid`},${p.displayName},${p.hash},'active')`;
        await tx`insert into allrice_memberships(organization_id,user_id,role,active) values(${id},${p.id},'member',true)`;
        await tx`insert into allrice_organization_people(organization_id,user_id,display_name,job_title,responsibilities)
        values(${id},${p.id},${p.displayName},${p.jobTitle},${p.responsibilities})`;
        await audit(tx, context, id, 'organization.employee.created', p.id);
      }
      await synchronizeTenantMembershipAccess(tx, {
        organizationId: id,
        workspaceId: null,
      });
      return {
        created: prepared.map((p) => ({
          userId: p.id,
          username: p.username,
          displayName: p.displayName,
        })),
      };
    }),
  );
}

async function lockPerson(
  tx: postgres.TransactionSql,
  context: RequestContext,
  organizationId: string,
  userId: string,
  version?: string,
) {
  await requireTenantAdministrationAuthority(context, tx);
  await requireTenantAdministrationTarget(tx, organizationId, null);
  await tx`select id from allrice_users where id=${userId} for update`;
  const [row] = await peopleRows(tx, organizationId, { userId });
  if (!row) throw new DataAccessError('not_found');
  if (await isPlatformAdmin({ actor: { type: 'user', id: userId } }, tx))
    throw new DataAccessError('authorization_denied');
  if (version && row.version !== version)
    throw new OrganizationAdministrationError('account_conflict');
  return row;
}

export async function updateOrganizationPerson(
  context: RequestContext,
  idInput: string,
  userInput: string,
  input: unknown,
) {
  const id = UuidSchema.parse(idInput),
    userId = UuidSchema.parse(userInput),
    value = OrganizationPersonUpdateSchema.parse(input);
  checkUsername(value.username);
  return uniqueAccount(() =>
    getDatabase().begin(async (tx) => {
      await lockPerson(tx, context, id, userId, value.expectedVersion);
      await tx`update allrice_users set username=${value.username},updated_at=now() where id=${userId}`;
      await tx`insert into allrice_organization_people(organization_id,user_id,display_name,job_title,responsibilities)
      values(${id},${userId},${value.displayName},${value.jobTitle},${value.responsibilities})
      on conflict(organization_id,user_id) do update set display_name=excluded.display_name,job_title=excluded.job_title,responsibilities=excluded.responsibilities,updated_at=clock_timestamp()`;
      await audit(tx, context, id, 'organization.employee.updated', userId);
      return { person: person((await peopleRows(tx, id, { userId }))[0]!) };
    }),
  );
}

export async function setOrganizationAccountStatus(
  context: RequestContext,
  idInput: string,
  userInput: string,
  input: unknown,
) {
  const id = UuidSchema.parse(idInput),
    userId = UuidSchema.parse(userInput),
    value = OrganizationAccountStatusSchema.parse(input);
  return getDatabase().begin(async (tx) => {
    await lockPerson(tx, context, id, userId, value.expectedVersion);
    await tx`update allrice_users set status=${value.active ? 'active' : 'disabled'},updated_at=now() where id=${userId}`;
    if (!value.active)
      await tx`update allrice_sessions set revoked_at=now() where user_id=${userId} and revoked_at is null`;
    await audit(tx, context, id, 'organization.employee.status', userId, {
      active: value.active,
    });
    return { person: person((await peopleRows(tx, id, { userId }))[0]!) };
  });
}

export async function resetOrganizationPassword(
  context: RequestContext,
  idInput: string,
  userInput: string,
  input: unknown,
) {
  const id = UuidSchema.parse(idInput),
    userId = UuidSchema.parse(userInput),
    value = OrganizationPasswordResetSchema.parse(input);
  await requireTenantAdministrationAuthority(context, getDatabase());
  const hash = await hashPassword(value.password);
  await getDatabase().begin(async (tx) => {
    await lockPerson(tx, context, id, userId);
    await tx`update allrice_users set password_hash=${hash},updated_at=now() where id=${userId}`;
    await tx`update allrice_sessions set revoked_at=now() where user_id=${userId} and revoked_at is null`;
    await audit(
      tx,
      context,
      id,
      'organization.employee.password_reset',
      userId,
    );
  });
  return { reset: true };
}
