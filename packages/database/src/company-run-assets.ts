import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  CompanyAssetRevisionSchema,
  CompanyRunSnapshotSchema,
  CompanyTemplateSelectionSchema,
  StorageObjectSchema,
  UuidSchema,
  makeObjectKey,
  runtimeContractEqual,
  authorizeExecution,
  type CompanyAssetRevision,
  type CompanyRunSnapshot,
  type ExecutionContext,
  type RequestContext,
  type StorageObject,
  type StoragePort,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { DataAccessError } from './data.ts';
import {
  CompanyAssetError,
  requireCompanyAssetReader,
} from './company-assets.ts';
import { readArtifactBytes } from './artifact-review.ts';

type Db = ReturnType<typeof getDatabase>;
type Sql = Db | postgres.TransactionSql;
type RevisionRow = {
  asset_id: string;
  id: string;
  number: number;
  digest: string;
  content: CompanyAssetRevision['content'];
  file_metadata: CompanyAssetRevision['file'];
  created_at: Date;
};
function revision(row: RevisionRow) {
  return CompanyAssetRevisionSchema.parse({
    id: row.id,
    number: row.number,
    digest: row.digest,
    content: row.content,
    file: row.file_metadata,
    createdAt: row.created_at.toISOString(),
  });
}
export class CompanyRunAssetError extends Error {
  constructor(
    readonly code:
      'parameters_invalid' | 'material_too_large' | 'selection_changed',
  ) {
    super(code);
  }
}

/** Called only for a new input, inside its existing idempotent admission TX. */
export async function captureCompanyRunAssets(
  tx: postgres.TransactionSql,
  context: RequestContext,
  employeeId: string,
  text: string,
  selections: unknown = [],
): Promise<CompanyRunSnapshot> {
  const chosen = CompanyTemplateSelectionSchema.array()
    .max(3)
    .parse(selections);
  if (new Set(chosen.map((s) => s.assetId)).size !== chosen.length)
    throw new CompanyRunAssetError('selection_changed');
  // Existing callers already authorize ordinary message admission. Company
  // authority is an additional gate only when this input uses company material;
  // an empty publication must not impose a new login protocol on legacy callers.
  if (chosen.length)
    await requireCompanyAssetReader(context, context.organizationId, tx);
  const [platform] = await tx<{ employee_id: string }[]>`
    select employee_id from allrice_platform_employee_tenant_assignments
    where organization_id=${context.organizationId} and workspace_id=${context.workspaceId}
      and tenant_employee_id=${UuidSchema.parse(employeeId)} and active limit 1`;
  const candidates = await tx<RevisionRow[]>`
    select r.* from allrice_company_assets a
    join allrice_company_asset_revisions r on r.id=a.published_revision_id and r.asset_id=a.id
    where a.organization_id=${context.organizationId} and a.kind='rule' and a.state='published'
    order by a.id for share of a,r`;
  const task = text.toLocaleLowerCase();
  const rules = candidates.flatMap((row) => {
    const r = revision(row),
      c = r.content;
    if (
      c.appliesToEmployeeIds.length &&
      (!platform || !c.appliesToEmployeeIds.includes(platform.employee_id))
    )
      return [];
    if (
      c.taskKeywords.length &&
      !c.taskKeywords.some((k) => task.includes(k.toLocaleLowerCase()))
    )
      return [];
    return [{ assetId: row.asset_id, revision: r }];
  });
  const templates: CompanyRunSnapshot['templates'] = [];
  if (rules.length && !chosen.length)
    await requireCompanyAssetReader(context, context.organizationId, tx);
  for (const selection of chosen) {
    const [row] = await tx<RevisionRow[]>`
      select r.* from allrice_company_assets a
      join allrice_company_asset_revisions r on r.asset_id=a.id
      join allrice_company_asset_publications p on p.asset_id=a.id and p.revision_id=r.id
      join allrice_storage_objects o on o.id=r.snapshot_object_id and o.state='ready' and o.deleted_at is null
      where a.organization_id=${context.organizationId} and a.id=${selection.assetId}
        and a.kind='template' and a.state='published' and r.id=${selection.revisionId} and r.digest=${selection.digest}
        and (o.retention_until is null or o.retention_until>clock_timestamp()) for share of a,r,o`;
    if (!row) throw new CompanyAssetError('asset_unavailable');
    const r = revision(row);
    if (!r.file || r.file.sizeBytes > 20 * 1024 * 1024)
      throw new CompanyRunAssetError('material_too_large');
    if (
      Object.keys(selection.parameters).some(
        (key) => !r.content.slots.some((s) => s.key === key),
      ) ||
      r.content.slots.some(
        (s) => s.required && !selection.parameters[s.key]?.trim(),
      )
    )
      throw new CompanyRunAssetError('parameters_invalid');
    if (
      r.content.appliesToEmployeeIds.length &&
      (!platform ||
        !r.content.appliesToEmployeeIds.includes(platform.employee_id))
    )
      throw new CompanyRunAssetError('selection_changed');
    templates.push({
      assetId: row.asset_id,
      revision: r,
      parameters: selection.parameters,
    });
  }
  return CompanyRunSnapshotSchema.parse({
    organizationId: context.organizationId,
    rules,
    templates,
  });
}

export type CompanyRunReader = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  runId: string;
};
export function companyRunReader(context: ExecutionContext): CompanyRunReader {
  if (
    !context.workspaceId ||
    context.delegatedBy.type !== 'user' ||
    context.delegatedBy.id !== context.policySnapshot.subjectId
  )
    throw new DataAccessError('authorization_denied');
  return {
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    ownerId: context.policySnapshot.subjectId,
    runId: context.runId,
  };
}
async function runSnapshot(sql: Sql, reader: CompanyRunReader) {
  for (const v of Object.values(reader)) UuidSchema.parse(v);
  const [row] = await sql<{ prompt_snapshot: { companyAssets?: unknown } }[]>`
    select e.prompt_snapshot from allrice_employee_runs e
    join allrice_runs r on r.id=e.run_id and r.owner_id=e.owner_id and r.organization_id=e.organization_id and r.workspace_id=e.workspace_id
    join allrice_users u on u.id=e.owner_id and u.status='active'
    join allrice_organizations o on o.id=e.organization_id and o.archived_at is null
    join allrice_workspaces w on w.id=e.workspace_id and w.organization_id=o.id and w.archived_at is null
    where e.run_id=${reader.runId} and e.organization_id=${reader.organizationId}
      and e.workspace_id=${reader.workspaceId} and e.owner_id=${reader.ownerId}
      and exists(select 1 from allrice_memberships m where m.organization_id=e.organization_id and m.user_id=e.owner_id
        and m.active and m.role in ('member','admin') and (m.workspace_id is null or m.workspace_id=e.workspace_id))`;
  if (!row) throw new DataAccessError('authorization_denied');
  if (!row.prompt_snapshot.companyAssets) return null;
  const snapshot = CompanyRunSnapshotSchema.parse(
    row.prompt_snapshot.companyAssets,
  );
  if (snapshot.organizationId !== reader.organizationId)
    throw new DataAccessError('authorization_denied');
  return snapshot;
}
async function publishedFile(
  sql: Sql,
  reader: CompanyRunReader,
  reference: CompanyRunSnapshot['templates'][number],
) {
  const [row] = await sql<{ object: unknown }[]>`
    select jsonb_build_object('id',o.id,'organizationId',o.organization_id,'workspaceId',o.workspace_id,'ownerId',o.owner_id,
      'key',o.object_key,'checksum',o.checksum,'mediaType',o.media_type,'sizeBytes',o.size_bytes,
      'retentionUntil',o.retention_until,'deletedAt',o.deleted_at,'immutable',o.immutable) as object
    from allrice_company_assets a join allrice_company_asset_revisions r on r.asset_id=a.id
    join allrice_company_asset_publications p on p.asset_id=a.id and p.revision_id=r.id
    join allrice_storage_objects o on o.id=r.snapshot_object_id
    where a.organization_id=${reader.organizationId} and a.id=${reference.assetId} and a.state='published'
      and r.id=${reference.revision.id} and r.digest=${reference.revision.digest}
      and o.id=${reference.revision.file!.objectId} and o.checksum=${reference.revision.file!.checksum}
      and o.size_bytes=${reference.revision.file!.sizeBytes} and o.media_type=${reference.revision.file!.mediaType}
      and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())
    for share of a,r,o`;
  if (!row) throw new CompanyAssetError('asset_unavailable');
  return StorageObjectSchema.parse(row.object);
}

export async function recordCompanyRunSelections(
  tx: postgres.TransactionSql,
  reader: CompanyRunReader,
) {
  const snapshot = await runSnapshot(tx, reader);
  if (!snapshot) return;
  for (const reference of [...snapshot.rules, ...snapshot.templates])
    await tx`insert into allrice_company_run_assets(organization_id,workspace_id,owner_id,run_id,asset_id,revision_id,digest,kind,selected_at)
      values(${reader.organizationId},${reader.workspaceId},${reader.ownerId},${reader.runId},${reference.assetId},${reference.revision.id},
        ${reference.revision.digest},${reference.revision.content.kind},${reference.revision.content.kind === 'template' ? new Date() : null})
      on conflict(run_id,asset_id) do nothing`;
}

/** Stable per-reader input cache. It is never a DeliverableVersion or a generic
 * file grant. Every new read still needs this formal Run and live publication. */
export async function prepareCompanyRunMaterials(
  context: ExecutionContext,
  expected: CompanyRunSnapshot,
  storage: StoragePort,
  db: Db = getDatabase(),
) {
  const reader = companyRunReader(context);
  const copies: StorageObject[] = [];
  try {
    return await db.begin(async (tx) => {
      // Storage quota is the first lock, before run/material/publication locks.
      await lockWorkspaceStorageQuota(
        tx,
        reader.organizationId,
        reader.workspaceId,
      );
      const snapshot = await runSnapshot(tx, reader);
      if (!snapshot || !runtimeContractEqual(snapshot, expected))
        throw new CompanyRunAssetError('selection_changed');
      const materials: {
        assetId: string;
        revisionId: string;
        object: StorageObject;
        fileName: string;
      }[] = [];
      for (const reference of [...snapshot.rules, ...snapshot.templates]) {
        await tx`insert into allrice_company_run_assets(organization_id,workspace_id,owner_id,run_id,asset_id,revision_id,digest,kind,selected_at)
          values(${reader.organizationId},${reader.workspaceId},${reader.ownerId},${reader.runId},${reference.assetId},${reference.revision.id},
            ${reference.revision.digest},${reference.revision.content.kind},${reference.revision.content.kind === 'template' ? new Date() : null})
          on conflict(run_id,asset_id) do nothing`;
        if (!reference.revision.file) continue;
        const template = snapshot.templates.find(
          (t) => t.assetId === reference.assetId,
        )!;
        const source = await publishedFile(tx, reader, template);
        assertCompanyMaterialPolicy(context, {
          ...source,
          workspaceId: reader.workspaceId,
          ownerId: reader.ownerId,
        });
        const [cached] = await tx<{ object: unknown }[]>`
          select jsonb_build_object('id',o.id,'organizationId',o.organization_id,'workspaceId',o.workspace_id,'ownerId',o.owner_id,
            'key',o.object_key,'checksum',o.checksum,'mediaType',o.media_type,'sizeBytes',o.size_bytes,
            'retentionUntil',o.retention_until,'deletedAt',o.deleted_at,'immutable',o.immutable) as object
          from allrice_company_asset_materials m join allrice_storage_objects o on o.id=m.object_id
          where m.workspace_id=${reader.workspaceId} and m.organization_id=${reader.organizationId} and m.owner_id=${reader.ownerId}
            and m.revision_id=${template.revision.id} and o.owner_id=m.owner_id and o.workspace_id=m.workspace_id and o.organization_id=m.organization_id
            and o.checksum=${source.checksum} and o.size_bytes=${source.sizeBytes} and o.media_type=${source.mediaType}
            and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp()) for share of o`;
        let object = cached ? StorageObjectSchema.parse(cached.object) : null;
        if (!object) {
          const bytes = await readArtifactBytes(
            storage,
            source,
            20 * 1024 * 1024,
          );
          const [quota] = await tx<
            {
              limit_bytes: string | number | null;
              used_bytes: string | number;
            }[]
          >`
            select q.limit_bytes,coalesce(sum(o.size_bytes)filter(where o.state<>'deleted'),0) as used_bytes
            from allrice_workspaces w left join allrice_storage_quotas q on q.organization_id=w.organization_id and q.workspace_id=w.id
            left join allrice_storage_objects o on o.workspace_id=w.id and o.organization_id=w.organization_id
            where w.id=${reader.workspaceId} and w.organization_id=${reader.organizationId} group by q.limit_bytes`;
          if (
            !quota ||
            (quota.limit_bytes !== null &&
              Number(quota.used_bytes) + bytes.length >
                Number(quota.limit_bytes))
          )
            throw new DataAccessError('quota_exceeded');
          const id = randomUUID();
          object = {
            ...source,
            id,
            workspaceId: reader.workspaceId,
            ownerId: reader.ownerId,
            key: makeObjectKey({
              organizationId: reader.organizationId,
              workspaceId: reader.workspaceId,
              ownerId: reader.ownerId,
              category: 'uploads',
              objectId: id,
            }),
            retentionUntil: new Date(Date.now() + 30 * 86400_000).toISOString(),
            deletedAt: null,
            immutable: true,
          };
          copies.push(object);
          await tx`insert into allrice_storage_objects(id,organization_id,workspace_id,owner_id,object_key,category,
            media_type,size_bytes,checksum,visibility,state,immutable,retention_until)
            values(${id},${reader.organizationId},${reader.workspaceId},${reader.ownerId},${object.key},'uploads',${object.mediaType},
              ${object.sizeBytes},${object.checksum},'private','pending',true,${object.retentionUntil})`;
          await storage.put(
            object,
            new ReadableStream({
              start(c) {
                c.enqueue(bytes);
                c.close();
              },
            }),
          );
          await tx`update allrice_storage_objects set state='ready',updated_at=clock_timestamp() where id=${id} and state='pending'`;
          await tx`insert into allrice_company_asset_materials(organization_id,workspace_id,owner_id,revision_id,object_id)
            values(${reader.organizationId},${reader.workspaceId},${reader.ownerId},${template.revision.id},${id})
            on conflict(workspace_id,owner_id,revision_id) do update set object_id=excluded.object_id,created_at=clock_timestamp()`;
        }
        await tx`update allrice_company_run_assets set material_object_id=${object.id}
          where run_id=${reader.runId} and asset_id=${reference.assetId} and revision_id=${reference.revision.id} and digest=${reference.revision.digest}`;
        materials.push({
          assetId: reference.assetId,
          revisionId: reference.revision.id,
          object,
          fileName: template.revision.file!.fileName,
        });
      }
      return materials;
    });
  } catch (error) {
    for (const object of copies) {
      // COMMIT can succeed while its acknowledgement is lost. Only confirmed
      // absence in the primary database permits deletion; unknown keeps bytes.
      const rolledBack =
        await db`select id from allrice_storage_objects where id=${object.id}`
          .then((rows) => rows.length === 0)
          .catch(() => false);
      if (rolledBack)
        await storage
          .delete({ ...object, immutable: false })
          .catch(() => undefined);
    }
    throw error;
  }
}

/** Null means an ordinary file; a recognized company input can never fall back
 * to the generic file resolver after permission or Run binding is lost. */
export async function getCompanyRunMaterial(
  reader: CompanyRunReader,
  objectId: string,
  sql: Sql = getDatabase(),
) {
  const [known] = await sql<
    { id: string }[]
  >`select object_id as id from allrice_company_asset_materials where object_id=${UuidSchema.parse(objectId)}
    union select material_object_id as id from allrice_company_run_assets where material_object_id=${objectId} limit 1`;
  if (!known) return null;
  const snapshot = await runSnapshot(sql, reader);
  const [bound] = await sql<{ asset_id: string; revision_id: string }[]>`
    select asset_id,revision_id from allrice_company_run_assets where run_id=${reader.runId}
      and organization_id=${reader.organizationId} and workspace_id=${reader.workspaceId} and owner_id=${reader.ownerId}
      and material_object_id=${objectId} and kind='template'`;
  const reference = snapshot?.templates.find(
    (t) => t.assetId === bound?.asset_id && t.revision.id === bound.revision_id,
  );
  if (!reference) throw new DataAccessError('authorization_denied');
  await publishedFile(sql, reader, reference);
  const [row] = await sql<{ object: unknown }[]>`
    select jsonb_build_object('id',o.id,'organizationId',o.organization_id,'workspaceId',o.workspace_id,'ownerId',o.owner_id,
      'key',o.object_key,'checksum',o.checksum,'mediaType',o.media_type,'sizeBytes',o.size_bytes,
      'retentionUntil',o.retention_until,'deletedAt',o.deleted_at,'immutable',o.immutable) as object
    from allrice_company_asset_materials m join allrice_storage_objects o on o.id=m.object_id
    where m.object_id=${objectId} and m.revision_id=${reference.revision.id}
      and m.organization_id=${reader.organizationId} and m.workspace_id=${reader.workspaceId} and m.owner_id=${reader.ownerId}
      and o.organization_id=m.organization_id and o.workspace_id=m.workspace_id and o.owner_id=m.owner_id
      and o.checksum=${reference.revision.file!.checksum} and o.size_bytes=${reference.revision.file!.sizeBytes}
      and o.media_type=${reference.revision.file!.mediaType} and o.state='ready' and o.deleted_at is null
      and (o.retention_until is null or o.retention_until>clock_timestamp())`;
  if (!row) throw new CompanyAssetError('asset_unavailable');
  return {
    object: StorageObjectSchema.parse(row.object),
    fileName: reference.revision.file!.fileName,
    visibility: 'private' as const,
    artifactVersionId: null,
    artifactVersion: null,
    companyReference: reference,
  };
}

function assertCompanyMaterialPolicy(
  context: ExecutionContext,
  object: StorageObject,
) {
  if (
    !authorizeExecution(
      {
        type: 'storage_object',
        id: object.id,
        organizationId: object.organizationId,
        workspaceId: object.workspaceId,
        ownerId: object.ownerId,
        visibility: 'private',
        archivedAt: null,
      },
      'resource:read',
      context,
    ).allowed
  )
    throw new DataAccessError('authorization_denied');
}

export async function getCompanyMaterialForExecution(
  context: ExecutionContext,
  objectId: string,
  sql: Sql = getDatabase(),
) {
  const [known] = await sql<
    { id: string }[]
  >`select object_id as id from allrice_company_asset_materials where object_id=${UuidSchema.parse(objectId)}
    union select material_object_id as id from allrice_company_run_assets where material_object_id=${objectId} limit 1`;
  if (!known) return null;
  const file = await getCompanyRunMaterial(
    companyRunReader(context),
    objectId,
    sql,
  );
  if (file) assertCompanyMaterialPolicy(context, file.object);
  return file;
}

export async function markCompanyRunLoaded(context: ExecutionContext) {
  const reader = companyRunReader(context),
    db = getDatabase();
  await runSnapshot(db, reader);
  await db`update allrice_company_run_assets set loaded_at=coalesce(loaded_at,clock_timestamp())
    where run_id=${reader.runId} and organization_id=${reader.organizationId} and workspace_id=${reader.workspaceId} and owner_id=${reader.ownerId}`;
}
export async function markCompanyMaterialRead(
  context: ExecutionContext,
  objectId: string,
) {
  const db = getDatabase();
  if (!(await getCompanyMaterialForExecution(context, objectId, db))) return;
  const reader = companyRunReader(context);
  await db`update allrice_company_run_assets set read_at=coalesce(read_at,clock_timestamp())
    where run_id=${reader.runId} and material_object_id=${objectId} and organization_id=${reader.organizationId}
      and workspace_id=${reader.workspaceId} and owner_id=${reader.ownerId}`;
}
export async function recordCompanyDerivation(
  tx: postgres.TransactionSql,
  context: ExecutionContext,
  sourceObjectId: string,
  versionId: string,
) {
  const material = await getCompanyMaterialForExecution(
    context,
    sourceObjectId,
    tx,
  );
  if (!material) return;
  const reader = companyRunReader(context);
  await tx`insert into allrice_company_asset_derivations(run_id,asset_id,deliverable_version_id)
    values(${reader.runId},${material.companyReference.assetId},${UuidSchema.parse(versionId)}) on conflict do nothing`;
}
