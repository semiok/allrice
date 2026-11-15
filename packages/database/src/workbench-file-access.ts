import type { TransactionSql } from 'postgres';
import {
  ContentOwnershipSchema,
  type ContentPrincipal,
  type WorkbenchFileSharing,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import {
  readContentPrincipal,
  getContentAccess,
  type ContentIdentity,
} from './content-maintenance.ts';

const readySchemas = new WeakSet<object>();
export async function workbenchFileSchemaReady(sql: FilePolicyDatabase) {
  if (readySchemas.has(sql)) return true;
  const [row] = await sql<{ ready: boolean }[]>`
    select to_regclass('allrice_workbench_file_policies') is not null as ready
  `;
  if (row?.ready) readySchemas.add(sql);
  return row?.ready === true;
}

export type FilePolicyDatabase =
  ReturnType<typeof getDatabase> | TransactionSql;
export interface WorkbenchFilePolicy {
  object_id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  series_id: string | null;
  file_name: string;
  scope: WorkbenchFileSharing['scope'];
  department_ids: string[];
  reference_source_id: string | null;
  reference_enabled: boolean;
  revision: number;
}

export async function readWorkbenchFilePolicy(
  objectId: string,
  sql: FilePolicyDatabase = getDatabase(),
  lock: 'share' | 'update' | false = false,
) {
  if (!(await workbenchFileSchemaReady(sql))) return null;
  const [policy] = await sql<WorkbenchFilePolicy[]>`
    select p.* from allrice_workbench_file_policies p
    where p.object_id=${objectId}
      or p.series_id in (select d.series_id from allrice_deliverable_versions d where d.object_id=${objectId})
      or p.reference_source_id in (select r.knowledge_source_id from allrice_knowledge_revisions r where r.file_object_id=${objectId})
    order by p.object_id limit 1
    ${lock === 'update' ? sql`for update` : lock === 'share' ? sql`for share` : sql``}
  `;
  return policy ?? null;
}

export function evaluateWorkbenchFilePolicy(
  principal: ContentPrincipal | null,
  policy: WorkbenchFilePolicy,
) {
  if (!principal || principal.organizationId !== policy.organization_id)
    return { canRead: false, canMaintain: false };
  const owner = principal.userId === policy.owner_id;
  return { canRead: owner, canMaintain: owner && principal.writable };
}

/** null means this is a legacy resource and its existing authority applies. */
export async function workbenchFileAccess(
  context: ContentIdentity,
  objectId: string,
  sql: FilePolicyDatabase = getDatabase(),
  lockForWrite = false,
) {
  // Identity/department locks precede file locks, like content maintenance.
  const policy = await readWorkbenchFilePolicy(objectId, sql);
  if (!policy) return null;
  const principal = await readContentPrincipal(context, sql, lockForWrite);
  const [publication] = policy.reference_source_id
    ? await sql<
        { status: string }[]
      >`select status from allrice_knowledge_sources
        where id=${policy.reference_source_id} and publication_kind is not null
          and organization_id=${policy.organization_id}
        ${lockForWrite ? sql`for share` : sql``}`
    : [];
  const current = lockForWrite
    ? await readWorkbenchFilePolicy(objectId, sql, 'share')
    : policy;
  if (!current) return null;
  const departments = current.department_ids.length
    ? await sql<{ id: string; name: string }[]>`
        select id,name from allrice_departments
        where organization_id=${current.organization_id}
          and id in ${sql(current.department_ids)}
          and archived_at is null order by id
        ${lockForWrite ? sql`for share` : sql``}`
    : [];
  // Publication policies govern the retained copy only. Tenant maintenance
  // levels do not grant publisher rights or membership in another department.
  const publicationOwner = principal?.userId === current.owner_id;
  const publicationRead =
    publication?.status === 'active' &&
    principal?.organizationId === current.organization_id &&
    (publicationOwner ||
      current.scope === 'company' ||
      (current.scope === 'departments' &&
        principal.departmentId !== null &&
        departments.some((d) => d.id === principal.departmentId)));
  return {
    ...(publication
      ? {
          canRead: !!publicationRead,
          canMaintain: !!(
            publicationRead &&
            publicationOwner &&
            principal?.writable
          ),
        }
      : evaluateWorkbenchFilePolicy(principal, current)),
    policy: current,
    departments,
  };
}

/** Evaluate the original immutable file, never the snapshot creator's role. */
export async function workbenchOriginFileAccess(
  context: ContentIdentity,
  originObjectId: string,
  sql: FilePolicyDatabase,
  lockForWrite = false,
) {
  const denied = { canRead: false, canMaintain: false };
  if (lockForWrite) await readContentPrincipal(context, sql, true);
  // Read policy/identity locks before storage locks throughout this module.
  const current = await workbenchFileAccess(
    context,
    originObjectId,
    sql,
    lockForWrite,
  );
  const [origin] = await sql<
    {
      id: string;
      owner_id: string;
      workspace_id: string;
      visibility: 'private' | 'workspace' | 'organization';
    }[]
  >`
    select o.id,o.owner_id,o.workspace_id,o.visibility from allrice_storage_objects o
    join allrice_workspaces w on w.id=o.workspace_id and w.archived_at is null
    where o.id=${originObjectId} and o.organization_id=${context.organizationId}
      and o.state='ready' and o.deleted_at is null
      and (o.retention_until is null or o.retention_until>clock_timestamp())
    ${lockForWrite ? sql`for share of o,w` : sql``}
  `;
  if (!origin) return denied;
  if (current) {
    const principal = await readContentPrincipal(
      { ...context, workspaceId: origin.workspace_id },
      sql,
      lockForWrite,
    );
    const owner = principal?.userId === origin.owner_id;
    return {
      canRead: owner && current.canRead,
      canMaintain: owner && current.canMaintain,
    };
  }
  const [reference] = await sql<
    {
      ownership: unknown;
      status: string;
      legacy_company_asset_id: string | null;
    }[]
  >`
    select s.ownership,s.status,s.legacy_company_asset_id
    from allrice_knowledge_revisions r join allrice_knowledge_sources s on s.id=r.knowledge_source_id
    where r.file_object_id=${origin.id} and s.ownership is not null limit 1
  `;
  if (reference) {
    if (reference.status !== 'active' || reference.legacy_company_asset_id)
      return denied;
    const access = await getContentAccess(
      context,
      ContentOwnershipSchema.parse(reference.ownership),
      sql,
      lockForWrite,
    );
    return { canRead: access.canRead, canMaintain: access.canMaintain };
  }
  const principal = await readContentPrincipal(
    { ...context, workspaceId: origin.workspace_id },
    sql,
    lockForWrite,
  );
  if (!principal) return denied;
  const owner = origin.owner_id === principal.userId;
  return {
    canRead: owner,
    canMaintain: owner && principal.writable,
  };
}

/** Explicit snapshots do not become a durable authorization bypass. */
export async function workbenchReferenceAccess(
  context: ContentIdentity,
  sourceId: string,
  sql: FilePolicyDatabase,
  lockForWrite = false,
) {
  if (!(await workbenchFileSchemaReady(sql))) return null;
  const [binding] = await sql<{ origin_object_id: string }[]>`
    select b.origin_object_id from allrice_workbench_reference_bindings b
    join allrice_knowledge_sources s on s.id=b.source_id and s.organization_id=b.organization_id
    where b.source_id=${sourceId} and b.organization_id=${context.organizationId}
      and s.publication_kind is null and s.legacy_company_asset_id is null
  `;
  if (binding)
    return workbenchOriginFileAccess(
      context,
      binding.origin_object_id,
      sql,
      lockForWrite,
    );
  // Older artifact snapshots predate workbench bindings. Follow their exact
  // version/policy relation, never the retained copy creator or source author.
  const origins = await sql<{ owner_id: string; workspace_id: string }[]>`
    select o.owner_id,o.workspace_id from allrice_knowledge_sources s
    join allrice_knowledge_revisions r on r.knowledge_source_id=s.id
    join allrice_deliverable_versions v on v.id=r.source_artifact_version_id
      and v.organization_id=s.organization_id
    join allrice_storage_objects o on o.id=v.object_id and o.organization_id=s.organization_id
    where s.id=${sourceId} and s.organization_id=${context.organizationId}
      and s.publication_kind is null and s.legacy_company_asset_id is null
    union
    select o.owner_id,o.workspace_id from allrice_knowledge_sources s
    join allrice_workbench_file_policies p on p.reference_source_id=s.id
      and p.organization_id=s.organization_id
    join allrice_storage_objects o on o.id=p.object_id and o.organization_id=s.organization_id
    where s.id=${sourceId} and s.organization_id=${context.organizationId}
      and s.publication_kind is null and s.legacy_company_asset_id is null
  `;
  if (!origins.length) return null;
  let canMaintain = true;
  for (const origin of origins) {
    const principal = await readContentPrincipal(
      { ...context, workspaceId: origin.workspace_id },
      sql,
      lockForWrite,
    );
    if (principal?.userId !== origin.owner_id)
      return { canRead: false, canMaintain: false };
    canMaintain &&= principal.writable;
  }
  // A finished retained snapshot keeps its existing lifetime even if the
  // original bytes are later deleted; current owner membership still applies.
  return { canRead: true, canMaintain };
}
