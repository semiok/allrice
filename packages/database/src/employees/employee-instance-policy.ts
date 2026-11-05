import {
  isBaseRiceInstanceDefinition,
  type EmployeeInstanceSnapshot,
} from '@allrice/contracts';
import type { ContentSql } from './employee-content-model.ts';

/** This is a product boundary for the platform Rice, not all general instances.
 * Verify the source behind the materialized definition, without consulting any
 * display name or mutable draft. Callers retain owner/assignment/lease checks. */
export async function isBaseRiceInstance(
  instance: Pick<
    EmployeeInstanceSnapshot,
    'kind' | 'source' | 'assignmentId' | 'organizationId' | 'workspaceId'
  >,
  sql: ContentSql,
) {
  if (instance.kind !== 'general' || instance.source.kind !== 'platform')
    return false;
  const [row] = await sql<
    {
      employee_key: string;
      manifest: {
        schemaVersion?: number;
        key?: string;
        isDefaultRice?: boolean;
      };
    }[]
  >`
    select e.employee_key,v.manifest from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    join allrice_employee_versions v on v.employee_id=e.id and v.id=${instance.source.employeeVersionId}
      and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    join allrice_employee_version_sources s on s.employee_version_id=v.id and s.employee_id=e.id
      and s.organization_id=e.organization_id and s.workspace_id=e.workspace_id
    join allrice_platform_employee_revisions r on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
    join allrice_platform_employees p on p.id=r.employee_id
    where a.id=${instance.assignmentId} and a.organization_id=${instance.organizationId} and a.workspace_id=${instance.workspaceId}
      and s.platform_employee_id=${instance.source.templateId} and r.id=${instance.source.templateRevisionId}
      and r.checksum=${instance.source.templateChecksum} and r.revision=${instance.source.templateRevision}
      and p.employee_key='rice' and r.definition->>'key'='rice' and r.status='published'`;
  return (
    !!row &&
    isBaseRiceInstanceDefinition(instance, {
      key: row.employee_key,
      versionId: instance.source.employeeVersionId,
      definition: row.manifest,
    })
  );
}

/** Display-only predicate for an instance aliased `i`. The enclosing query
 * still limits personal names to their owner. Resolve the published platform
 * mapping, never a display name or an assignment's default selection flag. */
export function personalInstanceNameSql(sql: ContentSql) {
  return sql`(i.kind='custom' or (i.kind='general' and exists (
    select 1 from allrice_employee_assignments a
    join allrice_employees e on e.id=a.employee_id and e.organization_id=a.organization_id and e.workspace_id=a.workspace_id
    join allrice_employee_versions v on v.id=a.employee_version_id and v.employee_id=e.id and v.organization_id=e.organization_id and v.workspace_id=e.workspace_id
    join allrice_employee_version_sources s on s.employee_version_id=v.id and s.employee_id=e.id and s.organization_id=e.organization_id and s.workspace_id=e.workspace_id
    join allrice_platform_employee_revisions r on r.id=s.platform_revision_id and r.employee_id=s.platform_employee_id
    join allrice_platform_employees p on p.id=r.employee_id
    where a.id=i.assignment_id and a.organization_id=i.organization_id and a.workspace_id=i.workspace_id and a.user_id=i.owner_id
      and e.employee_key='default-assistant' and v.manifest->>'schemaVersion'='2'
      and v.manifest->>'key'='default-assistant' and v.manifest->>'isDefaultRice'='true'
      and p.employee_key='rice' and r.definition->>'key'='rice' and r.status='published'
  )))`;
}
