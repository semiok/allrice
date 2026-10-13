import type postgres from 'postgres';
import type {
  ContentOwnership,
  EmployeeContentManifest,
  EmployeeContentValidation,
  EmployeeContentMutation,
} from '@allrice/contracts';
import type { getDatabase } from '../core/client.ts';

export type ContentSql =
  ReturnType<typeof getDatabase> | postgres.TransactionSql;
export type ContentTx = postgres.TransactionSql;
export type ContentScope = EmployeeContentMutation['ownership'];
export type ContentTarget = EmployeeContentMutation['target'];
export type ContentSetRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  employee_id: string;
  instance_id: string | null;
  scope: ContentScope['scope'];
  owner_id: string | null;
  department_id: string | null;
  revision: number;
  candidate_revision_id: string | null;
  active_revision_id: string | null;
  validation: EmployeeContentValidation | null;
};
export type ContentRevisionRow = {
  id: string;
  set_id: string;
  number: number;
  manifest: EmployeeContentManifest;
  digest: string;
  change_summary: string;
  created_at: Date;
};
export class EmployeeContentError extends Error {
  constructor(
    readonly code:
      | 'version_conflict'
      | 'request_conflict'
      | 'source_changed'
      | 'validation_required'
      | 'validation_failed',
  ) {
    super(code);
  }
}
export function contentOwnership(
  row: Pick<
    ContentSetRow,
    'scope' | 'organization_id' | 'owner_id' | 'department_id'
  >,
): ContentScope {
  const organizationId = row.organization_id;
  if (row.scope === 'personal')
    return { scope: 'personal', organizationId, ownerId: row.owner_id! };
  if (row.scope === 'department')
    return {
      scope: 'department',
      organizationId,
      departmentId: row.department_id!,
    };
  return { scope: 'company', organizationId };
}
export function contentTarget(row: ContentSetRow): ContentTarget {
  return row.instance_id
    ? { kind: 'instance', instanceId: row.instance_id }
    : { kind: 'employee', employeeId: row.employee_id };
}
/** References may narrow access, never publish a private source to a wider audience. */
export function canReferenceScope(
  target: ContentScope,
  source: ContentOwnership,
) {
  if (source.scope === 'platform') return true;
  if (source.organizationId !== target.organizationId) return false;
  if (source.scope === 'company') return true;
  if (target.scope === 'personal')
    return source.scope !== 'personal' || source.ownerId === target.ownerId;
  return (
    source.scope === 'department' &&
    target.scope === 'department' &&
    source.departmentId === target.departmentId
  );
}
