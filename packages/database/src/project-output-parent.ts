import {
  UuidSchema,
  type DeliveryFormat,
  type ExecutionContext,
} from '@allrice/contracts';
import type { TransactionSql } from 'postgres';
import { getDatabase } from './core/client.ts';
import { projectFail } from './project-source.ts';

/** Explicit project output parents only; generic export history is unchanged.
 * Freshness is skipped for exact receipt replay, never current ACL/liveness.
 * lock=true publication callers already hold workspace quota, root/job and
 * session authority locks. Registration later takes its existing series lock. */
export async function assertExplicitOutputParent(
  input: {
    context: ExecutionContext;
    sessionId: string;
    parentObjectId: string;
    format: DeliveryFormat;
  },
  database: ReturnType<typeof getDatabase> | TransactionSql = getDatabase(),
  lock = false,
  requireLatest = false,
) {
  if (!input.context.workspaceId) projectFail('output_parent_unavailable');
  const [parent] = await database<
    {
      id: string;
      object_id: string;
      series_id: string;
      kind: string | null;
      provenance_kind: string | null;
      immutable: boolean;
      checksum: string;
      run_id: string | null;
      operation_id: string | null;
    }[]
  >`
    select v.id,v.object_id,v.series_id,a.kind,o.checksum,a.run_id,
      a.provenance->>'operationId' as operation_id,a.provenance->>'kind' as provenance_kind,o.immutable
    from allrice_deliverable_versions v
    join allrice_storage_objects o on o.id=v.object_id
      and o.organization_id=v.organization_id and o.workspace_id=v.workspace_id and o.owner_id=v.owner_id
    left join allrice_workbench_artifacts a on a.version_id=v.id
      and a.organization_id=v.organization_id and a.workspace_id=v.workspace_id and a.owner_id=v.owner_id
    join allrice_chat_sessions s on s.id=v.session_id
      and s.organization_id=v.organization_id and s.workspace_id=v.workspace_id
    where v.object_id=${UuidSchema.parse(input.parentObjectId)}
      and v.organization_id=${input.context.organizationId}
      and v.workspace_id=${input.context.workspaceId}
      and v.owner_id=${input.context.policySnapshot.subjectId}
      and v.session_id=${input.sessionId} and v.platform_test_run_id is null
      and s.owner_id=${input.context.policySnapshot.subjectId} and s.archived_at is null
      and v.format=${input.format}
      and o.state='ready' and o.deleted_at is null
      and (o.retention_until is null or o.retention_until>clock_timestamp())
    ${lock ? database`for update of v for share of o` : database``}
  `;
  if (!parent) projectFail('output_parent_unavailable');
  if (requireLatest) {
    const [latest] = await database<{ id: string }[]>`
      select id from allrice_deliverable_versions
      where series_id=${parent.series_id} and organization_id=${input.context.organizationId}
        and workspace_id=${input.context.workspaceId} and owner_id=${input.context.policySnapshot.subjectId}
      order by version desc limit 1
    `;
    if (latest?.id !== parent.id) projectFail('output_parent_stale');
  }
  return parent;
}

/** Projects require an immutable native file/document; a generic legacy Python
 * parent keeps its existing deliverable-version compatibility. */
export async function assertProjectOutputParent(
  input: Parameters<typeof assertExplicitOutputParent>[0],
  database: ReturnType<typeof getDatabase> | TransactionSql = getDatabase(),
  lock = false,
  requireLatest = false,
) {
  const parent = await assertExplicitOutputParent(
    input,
    database,
    lock,
    requireLatest,
  );
  if (
    !parent.immutable ||
    !['document', 'file'].includes(parent.kind ?? '') ||
    parent.provenance_kind === 'project_snapshot'
  )
    projectFail('output_parent_unavailable');
  return { ...parent, kind: parent.kind as 'document' | 'file' };
}
