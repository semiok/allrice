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
    select file_name from origins where id<>${objectId}`;
  return availableWorkbenchFileName(
    requested,
    new Set(rows.map((row) => row.file_name)),
  );
}
