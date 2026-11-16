import type postgres from 'postgres';
import {
  EmployeeModuleBindingSchema,
  type EmployeeModuleBinding,
  type EmployeeModuleRelease,
} from '@allrice/contracts';

export type EmployeeModuleScope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  instanceId: string;
};
export class EmployeeModuleError extends Error {
  constructor(readonly code: 'module_unavailable' | 'module_version_conflict') {
    super(code);
  }
}
export function sameEmployeeModuleRelease(
  a: EmployeeModuleRelease,
  b: EmployeeModuleRelease,
) {
  return (
    a.moduleId === b.moduleId &&
    a.contractVersion === b.contractVersion &&
    a.contentVersion === b.contentVersion &&
    a.digest === b.digest
  );
}
/** Caller supplies the current authenticated, locked instance scope. */
export async function readEmployeeModuleBinding(
  tx: postgres.TransactionSql,
  scope: EmployeeModuleScope,
  moduleId: string,
): Promise<EmployeeModuleBinding | null> {
  const [row] = await tx`select * from allrice_employee_module_bindings
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and owner_id=${scope.ownerId} and instance_id=${scope.instanceId}
      and module_id=${moduleId} for share`;
  return row
    ? EmployeeModuleBindingSchema.parse({
        ...scope,
        release: {
          moduleId: row.module_id,
          contractVersion: row.contract_version,
          contentVersion: row.content_version,
          digest: row.digest,
        },
        revision: row.revision,
        enabledAt: row.enabled_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
      })
    : null;
}
/** The same gate is usable with a frozen exact release/revision. It never
 * upgrades a Run by looking up the latest version under a display name. */
export async function requireEmployeeModuleBinding(
  tx: postgres.TransactionSql,
  scope: EmployeeModuleScope,
  release: EmployeeModuleRelease,
  expectedBindingRevision?: number,
) {
  const binding = await readEmployeeModuleBinding(tx, scope, release.moduleId);
  if (
    !binding ||
    binding.revokedAt ||
    Date.parse(binding.enabledAt) > Date.now()
  )
    throw new EmployeeModuleError('module_unavailable');
  if (
    !sameEmployeeModuleRelease(binding.release, release) ||
    (expectedBindingRevision !== undefined &&
      binding.revision !== expectedBindingRevision)
  )
    throw new EmployeeModuleError('module_version_conflict');
  return binding;
}
/** Add is intentionally not update/reactivate. Future explicit enablement
 * policy belongs to MET-253; an old or revoked binding cannot silently expand. */
export async function addEmployeeModuleBinding(
  tx: postgres.TransactionSql,
  scope: EmployeeModuleScope,
  release: EmployeeModuleRelease,
) {
  await tx`insert into allrice_employee_module_bindings
    (organization_id,workspace_id,owner_id,instance_id,module_id,contract_version,content_version,digest)
    values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},
      ${release.moduleId},${release.contractVersion},${release.contentVersion},${release.digest})
    on conflict (organization_id,workspace_id,owner_id,instance_id,module_id) do nothing`;
  return requireEmployeeModuleBinding(tx, scope, release);
}
