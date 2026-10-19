import {
  BrandContentScopeSchema,
  UuidSchema,
  type RequestContext,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { getEmployeeInstance } from '../employees/employee-instances.ts';
import { listWorkflowPackages } from '../capabilities/workflow-packages.ts';
import { listWorkspaceFiles } from '../workspace/service.ts';
import { getBrandContentBoard, listBrandContentBrands } from './reads.ts';

/** Private data for the current custom instance. The existing file list and
 * business readers remain responsible for live authority and source ACLs. */
export async function getBrandContentWorkspace(
  context: RequestContext,
  raw: { workspaceId: string; instanceId: string; brandId?: string },
) {
  const scope = BrandContentScopeSchema.parse({
    workspaceId: raw.workspaceId,
    instanceId: raw.instanceId,
  });
  await getEmployeeInstance(
    { ...context, workspaceId: scope.workspaceId },
    scope.instanceId,
  );
  const [catalog, brands, files] = await Promise.all([
    listWorkflowPackages(context, scope),
    listBrandContentBrands(context, scope),
    listWorkspaceFiles(context, scope.workspaceId),
  ]);
  const packages = catalog
    .filter(
      (entry) =>
        entry.binding?.enabled &&
        entry.binding.workflowRevisionId === entry.package.workflow.id &&
        entry.syncStatus !== 'source_unavailable',
    )
    .map((entry) => entry.package);
  const brandId = raw.brandId
    ? UuidSchema.parse(raw.brandId)
    : brands.brands[0]?.id;
  const board = brandId
    ? await getBrandContentBoard(context, { ...scope, brandId })
    : null;
  const owned = files.filter(
    (file) => file.ownedByMe && file.category === 'uploads',
  );
  const objects = owned.length
    ? await getDatabase()<
        { id: string; checksum: string }[]
      >`select id,checksum from allrice_storage_objects o
    where o.id in ${getDatabase()(owned.map((file) => file.id))}
      and o.organization_id=${context.organizationId} and o.workspace_id=${scope.workspaceId}
      and o.owner_id=${context.actor.id} and o.state='ready' and o.deleted_at is null
      and (o.retention_until is null or o.retention_until>clock_timestamp())
      and not exists(select 1 from allrice_workflow_packages p where p.manifest->'source'->>'objectId'=o.id::text)`
    : [];
  return {
    brands: brands.brands,
    board,
    packages,
    files: owned.flatMap((file) => {
      const object = objects.find((row) => row.id === file.id);
      return object
        ? [
            {
              objectId: file.id,
              fileName: file.fileName,
              mediaType: file.mediaType,
              checksum: object.checksum,
              sourceKind: 'uploaded' as const,
            },
          ]
        : [];
    }),
    truncated: brands.truncated || board?.truncated === true,
  };
}
