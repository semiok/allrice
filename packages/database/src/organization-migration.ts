/** Trusted, deployment-only migration. No HTTP endpoint invokes this module. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EmailSchema, UsernameSchema } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { hashPassword } from './identity.ts';
import { isPlatformAdmin } from './platform-authority.ts';

const schema = z
  .array(
    z.object({
      email: EmailSchema,
      username: UsernameSchema,
      organizationSlug: z.string().min(1),
      workspaceSlug: z.string().min(1),
      kind: z.enum(['employee', 'platform_admin']),
      initialPassword: z.string().min(8).max(256).optional(),
    }),
  )
  .min(1)
  .max(100);
export type LegacyAccountMigration = z.input<typeof schema>;
export async function migrateLegacyOrganizationAccounts(
  input: LegacyAccountMigration,
  apply = false,
) {
  const values = schema.parse(input),
    db = getDatabase();
  if (
    new Set(values.map((v) => v.username)).size !== values.length ||
    new Set(values.map((v) => v.email)).size !== values.length
  )
    throw Error('duplicate_migration_account');
  return db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('met161-account-migration'))`;
    const receipts: {
      userId: string;
      organizationId: string;
      workspaceId: string;
      username: string;
      action: 'initialize' | 'preserve' | 'disabled';
      kind: 'employee' | 'platform_admin';
    }[] = [];
    for (const value of [...values].sort((a, b) =>
      a.email.localeCompare(b.email),
    )) {
      const [user] = await tx<
        { id: string; username: string | null; status: string }[]
      >`select id,username,status from allrice_users where lower(email)=${value.email} for update`;
      if (!user) throw Error('migration_account_missing');
      const [scope] = await tx<
        { organization_id: string; workspace_id: string }[]
      >`select o.id as organization_id,w.id as workspace_id from allrice_organizations o join allrice_workspaces w on w.organization_id=o.id
        where o.slug=${value.organizationSlug} and o.archived_at is null and w.slug=${value.workspaceSlug} and w.archived_at is null
        and exists(select 1 from allrice_memberships m where m.organization_id=o.id and m.user_id=${user.id} and (m.workspace_id is null or m.workspace_id=w.id))`;
      if (!scope) throw Error('migration_scope_missing');
      const admin = await isPlatformAdmin(
        { actor: { type: 'user', id: user.id } },
        tx,
      );
      if (
        user.status === 'active' &&
        admin !== (value.kind === 'platform_admin')
      )
        throw Error('migration_principal_kind_mismatch');
      const action =
        user.status !== 'active'
          ? 'disabled'
          : user.username
            ? 'preserve'
            : 'initialize';
      const username = user.username ?? value.username;
      const [conflict] =
        await tx`select id from allrice_users where username=${username} and id<>${user.id}`;
      if (conflict) throw Error('migration_username_taken');
      if (
        action === 'initialize' &&
        value.kind === 'platform_admin' &&
        !value.initialPassword
      )
        throw Error('migration_admin_password_required');
      if (apply && action === 'initialize') {
        const hash = await hashPassword(
          value.kind === 'employee'
            ? (value.initialPassword ?? 'admin@321')
            : value.initialPassword!,
        );
        await tx`update allrice_users set username=${username},password_hash=${hash},updated_at=now() where id=${user.id} and username is null`;
        await tx`update allrice_sessions set revoked_at=now() where user_id=${user.id} and revoked_at is null`;
      }
      if (apply) {
        // Existing profile edits, membership removals, deployments and personal
        // include/exclude choices are not resynchronized by this migration.
        await tx`insert into allrice_organization_people(organization_id,user_id,display_name)
          select distinct m.organization_id,u.id,u.display_name from allrice_memberships m join allrice_users u on u.id=m.user_id where u.id=${user.id} on conflict do nothing`;
        if (value.kind === 'employee') {
          await tx`update allrice_memberships set role='member',updated_at=now() where user_id=${user.id} and role='admin'`;
          await tx`update allrice_organizations set managed_employee_roster=true where id=${scope.organization_id} and not managed_employee_roster`;
        }
        if (action === 'initialize')
          await tx`insert into allrice_audit_events(organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
          values(${scope.organization_id},${user.id},'organization.login_migrated','organization_account',${user.id},'recorded','deployment_migration',${randomUUID()},${tx.json({ username, kind: value.kind })})`;
      }
      receipts.push({
        userId: user.id,
        organizationId: scope.organization_id,
        workspaceId: scope.workspace_id,
        username,
        action,
        kind: value.kind,
      });
    }
    return { applied: apply, accounts: receipts };
  });
}
