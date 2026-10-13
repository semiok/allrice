import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  OrganizationDepartmentCreateSchema,
  OrganizationDepartmentUpdateSchema,
  UuidSchema,
  type OrganizationDepartment,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
export class OrganizationDepartmentError extends Error {
  constructor(
    readonly code:
      | 'department_conflict'
      | 'department_name_taken'
      | 'department_in_use'
      | 'department_inactive'
      | 'department_request_conflict',
  ) {
    super(code);
  }
}
function department(row: Record<string, unknown>): OrganizationDepartment {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    name: String(row.name),
    revision: Number(row.revision),
    active: row.archived_at === null,
    peopleCount: Number(row.people_count),
  };
}
async function rows(
  sql: Sql,
  organizationId: string,
  options: { id?: string; after?: string } = {},
) {
  return sql`select d.*,
    (select count(*)::int from allrice_organization_people p
      where p.organization_id=d.organization_id and p.department_id=d.id) as people_count
    from allrice_departments d where d.organization_id=${organizationId}
      and (${options.id ?? null}::uuid is null or d.id=${options.id ?? null})
      and (${options.after ?? null}::uuid is null or d.id>${options.after ?? null})
    order by d.id limit 101`;
}
async function authority(
  sql: Sql,
  context: RequestContext,
  organizationId: string,
) {
  await requireTenantAdministrationAuthority(context, sql);
  await requireTenantAdministrationTarget(sql, organizationId, null);
}
async function uniqueName<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505' &&
      'constraint_name' in error &&
      error.constraint_name === 'allrice_departments_active_name'
    ) {
      throw new OrganizationDepartmentError('department_name_taken');
    }
    throw error;
  }
}

/** Used only after the caller has checked the person and company authority.
 * The shared row lock serializes assignment against department deactivation. */
export async function requireActiveOrganizationDepartment(
  sql: Sql,
  organizationId: string,
  departmentId: string,
) {
  const [row] = await sql`select id,archived_at from allrice_departments
    where organization_id=${organizationId} and id=${departmentId} for share`;
  if (!row) throw new DataAccessError('not_found');
  if (row.archived_at !== null)
    throw new OrganizationDepartmentError('department_inactive');
}

export async function listOrganizationDepartments(
  context: RequestContext,
  organizationInput: string,
  afterInput?: string,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    after = afterInput ? UuidSchema.parse(afterInput) : undefined,
    sql = getDatabase();
  await authority(sql, context, organizationId);
  const found = await rows(sql, organizationId, { after });
  return {
    organizationId,
    departments: found.slice(0, 100).map(department),
    nextCursor: found.length > 100 ? String(found[99]!.id) : null,
  };
}

export async function createOrganizationDepartment(
  context: RequestContext,
  organizationInput: string,
  input: unknown,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    value = OrganizationDepartmentCreateSchema.parse(input);
  return uniqueName(() =>
    getDatabase().begin(async (tx) => {
      await authority(tx, context, organizationId);
      // Serialize first creation/replay in this company; a lost response must not
      // create a second department or accept a different payload for the same ID.
      await tx`select id from allrice_organizations where id=${organizationId} for no key update`;
      const [previous] = await tx`select id,create_name from allrice_departments
      where organization_id=${organizationId} and create_request_id=${value.requestId}`;
      if (previous) {
        if (previous.create_name !== value.name)
          throw new OrganizationDepartmentError('department_request_conflict');
        return {
          department: department(
            (await rows(tx, organizationId, { id: String(previous.id) }))[0]!,
          ),
        };
      }
      const id = randomUUID();
      await tx`insert into allrice_departments(id,organization_id,name,create_request_id,create_name)
      values(${id},${organizationId},${value.name},${value.requestId},${value.name})`;
      await tx`insert into allrice_audit_events(organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
      values(${organizationId},${context.actor.id},'organization.department.created','organization_department',${id},'recorded','organization.department.created',${context.requestId})`;
      return {
        department: department((await rows(tx, organizationId, { id }))[0]!),
      };
    }),
  );
}

export async function updateOrganizationDepartment(
  context: RequestContext,
  organizationInput: string,
  departmentInput: string,
  input: unknown,
) {
  const organizationId = UuidSchema.parse(organizationInput),
    id = UuidSchema.parse(departmentInput),
    value = OrganizationDepartmentUpdateSchema.parse(input);
  return uniqueName(() =>
    getDatabase().begin(async (tx) => {
      await authority(tx, context, organizationId);
      const [current] = await tx`select * from allrice_departments
      where organization_id=${organizationId} and id=${id} for update`;
      if (!current) throw new DataAccessError('not_found');
      if (current.revision !== value.expectedRevision)
        throw new OrganizationDepartmentError('department_conflict');
      if (!value.active) {
        const [reference] =
          await tx`select user_id from allrice_organization_people
        where organization_id=${organizationId} and department_id=${id} limit 1`;
        if (reference)
          throw new OrganizationDepartmentError('department_in_use');
      }
      await tx`update allrice_departments set name=${value.name}, revision=revision+1,
      archived_at=case when ${value.active} then null else coalesce(archived_at,clock_timestamp()) end,
      updated_at=clock_timestamp() where organization_id=${organizationId} and id=${id}`;
      await tx`insert into allrice_audit_events(organization_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${organizationId},${context.actor.id},'organization.department.updated','organization_department',${id},'recorded','organization.department.updated',${context.requestId},${tx.json({ revision: value.expectedRevision + 1, active: value.active })})`;
      return {
        department: department((await rows(tx, organizationId, { id }))[0]!),
      };
    }),
  );
}
