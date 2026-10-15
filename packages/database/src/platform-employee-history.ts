import {
  PlatformEmployeeHistoryDirectorySchema,
  PlatformEmployeeHistoryQuerySchema,
  PlatformEmployeeHistorySchema,
  PlatformEmployeeRevisionHistoryQuerySchema,
  PlatformEmployeeRevisionSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import { requireTenantAdministrationAuthority } from './tenant-administration.ts';

/** History uses saved revisions, including archived templates. No read revives
 * an assignment, rewrites a draft, or hydrates today's skill catalog. */
export async function listPlatformEmployeeHistoryDirectory(
  context: RequestContext,
  input: unknown = {},
) {
  const query = PlatformEmployeeHistoryQuerySchema.parse(input);
  const search = query.search?.toLowerCase() || null;
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      await requireTenantAdministrationAuthority(context, sql);
      const rows = await sql`select id,employee_key as "employeeKey",name,status
      from allrice_platform_employees
      where (${query.after ?? null}::uuid is null or id>${query.after ?? null})
        and (${search}::text is null or position(${search} in lower(name||' '||employee_key))>0)
      order by id limit 51`;
      return PlatformEmployeeHistoryDirectorySchema.parse({
        employees: rows.slice(0, 50),
        nextCursor: rows.length > 50 ? rows[49]!.id : null,
      });
    },
  );
}

export async function readPlatformEmployeeHistory(
  context: RequestContext,
  employeeInput: string,
  input: unknown = {},
) {
  const employeeId = UuidSchema.parse(employeeInput);
  const query = PlatformEmployeeRevisionHistoryQuerySchema.parse(input);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      await requireTenantAdministrationAuthority(context, sql);
      const [employee] =
        await sql`select id,employee_key as "employeeKey",name,status from allrice_platform_employees where id=${employeeId}`;
      if (!employee) throw new DataAccessError('not_found');
      const rows =
        await sql`select id,employee_id as "employeeId",revision,status,checksum,created_at,published_at
      from allrice_platform_employee_revisions where employee_id=${employeeId}
        and (${query.before ?? null}::integer is null or revision<${query.before ?? null})
      order by revision desc limit 51`;
      return PlatformEmployeeHistorySchema.parse({
        employee,
        revisions: rows.slice(0, 50).map((row) => ({
          id: row.id,
          employeeId: row.employeeId,
          revision: row.revision,
          status: row.status,
          checksum: row.checksum,
          createdAt: (row.created_at as Date).toISOString(),
          publishedAt: (row.published_at as Date | null)?.toISOString() ?? null,
        })),
        nextBefore: rows.length > 50 ? rows[49]!.revision : null,
      });
    },
  );
}

export async function readPlatformEmployeeHistoryRevision(
  context: RequestContext,
  employeeInput: string,
  revisionInput: string,
) {
  const employeeId = UuidSchema.parse(employeeInput),
    revisionId = UuidSchema.parse(revisionInput);
  return getDatabase().begin(
    'isolation level repeatable read read only',
    async (sql) => {
      await requireTenantAdministrationAuthority(context, sql);
      const [row] =
        await sql`select * from allrice_platform_employee_revisions where id=${revisionId} and employee_id=${employeeId}`;
      if (!row) throw new DataAccessError('not_found');
      return PlatformEmployeeRevisionSchema.parse({
        id: row.id,
        employeeId: row.employee_id,
        revision: row.revision,
        status: row.status,
        definition: row.definition,
        runtimeProfile: row.runtime_profile,
        checksum: row.checksum,
        createdAt: (row.created_at as Date).toISOString(),
        publishedAt: (row.published_at as Date | null)?.toISOString() ?? null,
      });
    },
  );
}
