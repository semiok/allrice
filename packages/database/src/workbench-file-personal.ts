import type { TransactionSql } from 'postgres';
import type { getDatabase } from './core/client.ts';

export type PersonalFileDatabase =
  ReturnType<typeof getDatabase> | TransactionSql;

/** Explicit business deliveries plus compatible legacy documents. Tool paging,
 * raw command output and browser evidence are not business delivery counts. */
export function businessDeliverablePredicate(db: PersonalFileDatabase) {
  return db`(
    (a.version_id is not null and a.kind in ('document','plan','file')
      and coalesce(a.provenance->>'kind','') <> 'project_snapshot')
    or (a.version_id is null and not (
      coalesce(dv.change_summary,'') like 'Tool result %; Run %; call %'
      and dv.file_name='tool-result-' || replace(replace(split_part(dv.change_summary,';',1),'Tool result ',''),'.','-') || '-' || dv.object_id::text || '.txt'
    ))
  )`;
}

export function isBusinessDeliverable(kind: string, provenanceKind: string) {
  return (
    ['document', 'plan', 'file'].includes(kind) &&
    provenanceKind !== 'project_snapshot'
  );
}

/** Same owner-only origins for the directory, favorite eligibility and name allocation. */
export function personalWorkbenchOrigins(
  sql: PersonalFileDatabase,
  scope: { organizationId: string; workspaceId: string; ownerId: string },
) {
  return sql`business as (
    select dv.* from allrice_deliverable_versions dv
    join allrice_chat_sessions s on s.id=dv.session_id and s.organization_id=dv.organization_id
      and s.workspace_id=dv.workspace_id and s.owner_id=${scope.ownerId}
    left join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id
      and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id
    where dv.organization_id=${scope.organizationId} and dv.workspace_id=${scope.workspaceId}
      and dv.owner_id=${scope.ownerId} and dv.platform_test_run_id is null
      and ${businessDeliverablePredicate(sql)}
  ), origins as (
    select o.id,o.created_at,case when b.object_id is null then 'upload' else 'artifact' end as category,
      coalesce(b.file_name,f.file_name,p.file_name,'未命名文件') as file_name
    from allrice_storage_objects o
    join allrice_workspaces w on w.id=o.workspace_id and w.organization_id=o.organization_id and w.archived_at is null
    left join lateral (select * from business where object_id=o.id order by created_at desc,id desc limit 1) b on true
    left join allrice_workbench_file_policies p on p.object_id=o.id and p.organization_id=o.organization_id and p.owner_id=o.owner_id
    left join lateral (select file_name from allrice_file_references where object_id=o.id and owner_id=${scope.ownerId} order by created_at limit 1) f on true
    where o.organization_id=${scope.organizationId} and o.workspace_id=${scope.workspaceId} and o.owner_id=${scope.ownerId}
      and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())
      and (b.object_id is not null or (o.category='uploads'
        and not exists(select 1 from allrice_deliverable_versions v where v.object_id=o.id)
        and ((p.upload_request_id is not null and p.upload_digest is not null)
          or exists(select 1 from allrice_file_references r join allrice_chat_sessions s on s.id=r.session_id
            and s.organization_id=r.organization_id and s.workspace_id=r.workspace_id
            where r.object_id=o.id and r.owner_id=${scope.ownerId} and s.owner_id=${scope.ownerId}))))
      and not exists(select 1 from allrice_knowledge_revisions r where r.file_object_id=o.id)
      and not exists(select 1 from allrice_company_asset_revisions r where r.snapshot_object_id=o.id)
      and not exists(select 1 from allrice_company_asset_materials m where m.object_id=o.id)
      and not exists(select 1 from allrice_company_run_assets r where r.material_object_id=o.id)
  )`;
}
