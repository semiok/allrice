import type postgres from 'postgres';
import type {
  ContentAccessDecision,
  ContentOwnership,
  RequestContext,
} from '@allrice/contracts';
import {
  requireTenantAdministrationAuthority,
  requireTenantAdministrationTarget,
} from './tenant-administration.ts';
import { DataAccessError } from './data.ts';

/** A server-created, transaction-scoped read capability. It keeps the real
 * administrator as actor and cannot authorize personal content or any write.
 * Ordinary tenant readers never receive this capability. */
export class OrganizationSharedReader {
  private constructor(
    readonly context: RequestContext,
    readonly departmentId: string | null,
  ) {}

  static async authorize(
    context: RequestContext,
    target: {
      organizationId: string;
      workspaceId: string;
      departmentId: string | null;
    },
    sql: postgres.TransactionSql,
  ) {
    await requireTenantAdministrationAuthority(context, sql);
    await requireTenantAdministrationTarget(
      sql,
      target.organizationId,
      target.workspaceId,
    );
    if (target.departmentId) {
      const [department] = await sql`select id from allrice_departments
        where id=${target.departmentId} and organization_id=${target.organizationId} and archived_at is null`;
      if (!department) throw new DataAccessError('not_found');
    }
    return new OrganizationSharedReader(
      { ...context, ...target },
      target.departmentId,
    );
  }

  access(ownership: ContentOwnership): ContentAccessDecision {
    const canRead =
      ownership.scope === 'platform' ||
      (ownership.scope !== 'personal' &&
        ownership.organizationId === this.context.organizationId &&
        (ownership.scope === 'company' ||
          ownership.departmentId === this.departmentId));
    return {
      canRead,
      canMaintain: false,
      readReason: canRead ? 'allowed' : 'private_owner_only',
      maintenanceReason: 'read_only_membership',
    };
  }
}
