import type { RequestContext, WorkbenchDeliverable } from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { workbenchFileAccess } from './workbench-file-access.ts';

/** Owner-only display association for the exact originals already on this page.
 * It neither grants publication access nor exposes originals to reference readers. */
export async function readOwnedReferencePublications(
  context: RequestContext,
  objectIds: string[],
  sql = getDatabase(),
) {
  const result = new Map<
    string,
    NonNullable<WorkbenchDeliverable['publication']>
  >();
  if (!objectIds.length) return result;
  const rows = await sql<
    {
      origin_id: string;
      source_id: string;
      revision_id: string;
      object_id: string;
    }[]
  >`select s.publication_origin_object_id as origin_id,s.id as source_id,
      r.id as revision_id,r.file_object_id as object_id
    from allrice_knowledge_sources s
    join allrice_knowledge_revisions r on r.knowledge_source_id=s.id and r.status='published'
    join allrice_storage_objects o on o.id=r.file_object_id and o.state='ready' and o.immutable
      and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())
    where s.organization_id=${context.organizationId} and s.workspace_id=${context.workspaceId!}
      and s.created_by=${context.actor.id} and s.publication_kind='file' and s.status='active'
      and s.publication_origin_object_id in ${sql(objectIds)}`;
  for (const row of rows) {
    const access = await workbenchFileAccess(context, row.object_id, sql);
    if (
      !access?.canRead ||
      access.policy.owner_id !== context.actor.id ||
      access.policy.reference_source_id !== row.source_id ||
      !access.policy.reference_enabled
    )
      continue;
    result.set(row.origin_id, {
      sourceId: row.source_id,
      revisionId: row.revision_id,
      audience: {
        scope: access.policy.scope,
        departmentIds: access.policy.department_ids,
      },
    });
  }
  return result;
}
