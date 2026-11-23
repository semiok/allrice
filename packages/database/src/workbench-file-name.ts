import { DeliverableVersionSchema } from '@allrice/contracts';
import {
  personalWorkbenchOrigins,
  type PersonalFileDatabase,
} from './workbench-file-personal.ts';

/** Exact names within the UTF-16 contract, without splitting a code point. */
export function availableWorkbenchFileName(
  requested: string,
  occupied: ReadonlySet<string>,
) {
  DeliverableVersionSchema.shape.fileName.parse(requested);
  if (!occupied.has(requested)) return requested;
  const dot = requested.lastIndexOf('.');
  const extension = dot > 0 ? requested.slice(dot) : '';
  const stem = dot > 0 ? requested.slice(0, dot) : requested;
  for (let number = 2; ; number++) {
    const suffix = `（${number}）`;
    // A legal original may devote almost all 255 units to the dot tail.
    // Only when that tail cannot fit, suffix the whole name instead.
    const tail = extension.length + suffix.length <= 255 ? extension : '';
    const budget = 255 - tail.length - suffix.length;
    let prefix = '';
    for (const point of tail ? stem : requested) {
      if (prefix.length + point.length > budget) break;
      prefix += point;
    }
    const candidate = prefix + suffix + tail;
    DeliverableVersionSchema.shape.fileName.parse(candidate);
    if (!occupied.has(candidate)) return candidate;
  }
}

/** Caller holds the existing workspace storage-quota mutex in this transaction. */
export async function allocateWorkbenchFileName(
  sql: PersonalFileDatabase,
  scope: {
    organizationId: string;
    workspaceId: string;
    ownerId: string;
  },
  objectId: string,
  requested: string,
) {
  const rows = await sql<
    { file_name: string }[]
  >`with ${personalWorkbenchOrigins(sql, scope)}
    select file_name from origins where id<>${objectId}
    union
    select p.file_name from allrice_workbench_file_policies p
    join allrice_storage_objects o on o.id=p.object_id
      and o.organization_id=p.organization_id and o.workspace_id=p.workspace_id and o.owner_id=p.owner_id
    where p.organization_id=${scope.organizationId} and p.workspace_id=${scope.workspaceId} and p.owner_id=${scope.ownerId}
      and p.object_id<>${objectId} and p.upload_request_id is not null and p.upload_digest is not null
      and o.category='uploads' and o.state='pending' and o.deleted_at is null
      and (o.retention_until is null or o.retention_until>clock_timestamp())`;
  return availableWorkbenchFileName(
    requested,
    new Set(rows.map((row) => row.file_name)),
  );
}
