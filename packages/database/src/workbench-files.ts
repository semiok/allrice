import { createHash, randomUUID } from 'node:crypto';
import {
  ContentOwnershipSchema,
  WorkbenchFileSchema,
  WorkbenchFileUpdateSchema,
  WorkbenchFileUploadSchema,
  UuidSchema,
  type RequestContext,
  type StorageObject,
  type StoragePort,
  type WorkbenchFile,
  type WorkbenchFileSharing,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import {
  createStorageMetadata,
  DataAccessError,
  getStoredFile,
  markStorageReady,
} from './data.ts';
import { readContentPrincipal } from './content-maintenance.ts';
import {
  completeReferenceUpload,
  getReferenceFile,
  listReferenceRevisions,
  prepareReferenceUpload,
  referenceLibraryOptions,
  referenceSourceAccess,
} from './reference-library.ts';
import { businessDeliverablePredicate } from './organization-dashboard.ts';
import { assertWorkbenchSession } from './artifact-review.ts';
import {
  canSetWorkbenchFileSharing,
  readWorkbenchFilePolicy,
  workbenchFileAccess,
  type FilePolicyDatabase,
} from './workbench-file-access.ts';

export class WorkbenchFileError extends Error {
  constructor(
    readonly code: 'version_conflict' | 'request_conflict' | 'invalid_file',
    message: string,
  ) {
    super(message);
  }
}
const digest = (value: string | Uint8Array) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
type Facts = {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  object_key: string;
  checksum: StorageObject['checksum'];
  media_type: string;
  size_bytes: number | string;
  retention_until: Date | null;
  deleted_at: Date | null;
  immutable: boolean;
  visibility: 'private' | 'workspace' | 'organization';
  category: string;
  created_at: Date;
  file_name: string;
  series_id: string | null;
  artifact_id: string | null;
  business_deliverable: boolean | null;
  artifact_version: number | null;
  artifact_session_id: string | null;
  artifact_session_owner: string | null;
  source_id: string | null;
  source_ownership: unknown;
  legacy_company_asset_id: string | null;
};
function scoped(context: RequestContext, workspaceId: string): RequestContext {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  UuidSchema.parse(workspaceId);
  if (context.workspaceId && context.workspaceId !== workspaceId)
    throw new DataAccessError('authorization_denied');
  return { ...context, workspaceId };
}
async function facts(objectId: string, sql: FilePolicyDatabase) {
  const [row] = await sql<Facts[]>`
    select o.*,coalesce(d.file_name,f.file_name,p.file_name,r.file_name,'未命名文件') as file_name,
      d.series_id,d.id as artifact_id,d.version as artifact_version,d.business_deliverable,
      d.session_id as artifact_session_id,d.session_owner as artifact_session_owner,
      r.source_id,r.ownership as source_ownership,r.legacy_company_asset_id
    from allrice_storage_objects o
    join allrice_workspaces w on w.id=o.workspace_id and w.archived_at is null
    left join allrice_workbench_file_policies p on p.object_id=o.id
    left join lateral (select dv.*,s.owner_id as session_owner,${businessDeliverablePredicate(sql)} as business_deliverable from allrice_deliverable_versions dv
      left join allrice_workbench_artifacts a on a.version_id=dv.id
      left join allrice_chat_sessions s on s.id=dv.session_id where dv.object_id=o.id order by dv.version desc limit 1) d on true
    left join lateral (select file_name from allrice_file_references where object_id=o.id order by created_at desc limit 1) f on true
    left join lateral (select kr.file_name,s.id as source_id,s.ownership,s.legacy_company_asset_id
      from allrice_knowledge_revisions kr join allrice_knowledge_sources s on s.id=kr.knowledge_source_id
      where kr.file_object_id=o.id and s.ownership is not null and kr.status='published'
      order by kr.revision desc limit 1) r on true
    where o.id=${UuidSchema.parse(objectId)} and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())
  `;
  if (!row) throw new DataAccessError('not_found');
  return row;
}
function object(row: Facts): StorageObject {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    key: row.object_key as StorageObject['key'],
    checksum: row.checksum,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    immutable: row.immutable,
    retentionUntil: row.retention_until?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}

/** Resolves a file without revealing the original private conversation. */
export async function readWorkbenchFile(
  context: RequestContext,
  objectId: string,
  sql: FilePolicyDatabase = getDatabase(),
) {
  const principal = await readContentPrincipal(context, sql);
  if (!principal) throw new DataAccessError('authorization_denied');
  const row = await facts(objectId, sql);
  if (row.source_id) {
    const [binding] = await sql<{ origin_object_id: string }[]>`
      select origin_object_id from allrice_workbench_reference_bindings
      where source_id=${row.source_id} and organization_id=${context.organizationId}`;
    // Retained bytes are only available through the governed reference. They
    // must never acquire an independent file policy that outlives its origin.
    if (binding && binding.origin_object_id !== row.id)
      throw new DataAccessError('not_found');
  }
  const policy = await workbenchFileAccess(context, objectId, sql);
  let canMaintain = false;
  if (policy) {
    if (!policy.canRead) throw new DataAccessError('not_found');
    canMaintain = policy.canMaintain;
  } else if (row.source_id) {
    const source = await referenceSourceAccess(context, row.source_id, sql);
    if (source.source.status !== 'active')
      throw new DataAccessError('not_found');
    canMaintain =
      source.access.canMaintain &&
      source.ownership.scope !== 'platform' &&
      !source.legacy;
  } else {
    await getStoredFile(context, objectId, sql);
    canMaintain =
      principal.writable &&
      (row.owner_id === principal.userId ||
        principal.maintenanceLevel === 'company');
  }
  return {
    row,
    object: object(row),
    policy: policy?.policy ?? null,
    departments: policy?.departments ?? [],
    canMaintain,
  };
}

async function validateTarget(
  context: RequestContext,
  ownerId: string,
  sharing: WorkbenchFileSharing,
  sql: FilePolicyDatabase,
) {
  const principal = await readContentPrincipal(context, sql, true);
  if (!principal || !canSetWorkbenchFileSharing(principal, ownerId, sharing))
    throw new DataAccessError('authorization_denied');
  if (sharing.departmentIds.length) {
    const departments = await sql<
      { id: string }[]
    >`select id from allrice_departments
      where organization_id=${context.organizationId} and id in ${sql(sharing.departmentIds)}
        and archived_at is null order by id for share`;
    if (departments.length !== sharing.departmentIds.length)
      throw new DataAccessError('authorization_denied');
  }
}

async function auditFile(
  context: RequestContext,
  objectId: string,
  workspaceId: string,
  action: string,
  revision: number,
  sql: FilePolicyDatabase,
) {
  await sql`insert into allrice_audit_events
    (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
    values (${context.organizationId},${workspaceId},${context.actor.id},${action},'storage_object',${objectId},'allowed',${'file_policy_revision_' + revision},${context.requestId})`;
}

export async function uploadWorkbenchFile(
  contextInput: RequestContext,
  input: unknown,
  storage: StoragePort,
) {
  const value = WorkbenchFileUploadSchema.parse(input),
    context = scoped(contextInput, value.workspaceId);
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.contentBase64) ||
    value.contentBase64.length % 4 !== 0
  )
    throw new WorkbenchFileError(
      'invalid_file',
      '文件内容未通过检查，请重新选择文件。',
    );
  const bytes = Buffer.from(value.contentBase64, 'base64'),
    checksum = digest(bytes);
  const requestDigest = digest(
    JSON.stringify({ ...value, contentBase64: checksum }),
  );
  const db = getDatabase();
  const prepared = await db.begin(async (tx) => {
    await lockWorkspaceStorageQuota(
      tx,
      context.organizationId,
      value.workspaceId,
    );
    await validateTarget(context, context.actor.id, value.sharing, tx);
    await tx`select pg_advisory_xact_lock(hashtextextended(${context.organizationId + '/' + context.actor.id + '/' + value.requestId},0))`;
    const [existing] = await tx<
      { object_id: string; upload_digest: string; state: string }[]
    >`
      select p.object_id,p.upload_digest,o.state from allrice_workbench_file_policies p
      join allrice_storage_objects o on o.id=p.object_id
      where p.organization_id=${context.organizationId} and p.owner_id=${context.actor.id} and p.upload_request_id=${value.requestId}`;
    if (existing) {
      if (existing.upload_digest !== requestDigest)
        throw new WorkbenchFileError(
          'request_conflict',
          '同一个上传请求包含了不同文件，请重新发起。',
        );
      return {
        objectId: existing.object_id,
        ready: existing.state === 'ready',
      };
    }
    const id = randomUUID();
    await createStorageMetadata(
      context,
      {
        id,
        workspaceId: value.workspaceId,
        category: 'uploads',
        mediaType: value.mediaType,
        sizeBytes: bytes.byteLength,
        checksum,
        visibility: 'private',
        retentionUntil: null,
        immutable: true,
      },
      tx,
    );
    await tx`insert into allrice_workbench_file_policies
      (object_id,organization_id,workspace_id,owner_id,file_name,scope,department_ids,upload_request_id,upload_digest)
      values (${id},${context.organizationId},${value.workspaceId},${context.actor.id},${value.fileName},${value.sharing.scope},${value.sharing.departmentIds},${value.requestId},${requestDigest})`;
    await auditFile(
      context,
      id,
      value.workspaceId,
      'workbench.file.upload',
      1,
      tx,
    );
    return { objectId: id, ready: false };
  });
  if (!prepared.ready) {
    const [pending] = await db<
      Facts[]
    >`select * from allrice_storage_objects where id=${prepared.objectId} and owner_id=${context.actor.id} and state='pending'`;
    if (!pending)
      throw new WorkbenchFileError(
        'invalid_file',
        '该上传已不可继续，请重新发起。',
      );
    await storage.put(
      object(pending),
      new Blob([new Uint8Array(bytes)]).stream(),
    );
    await db.begin(async (tx) => {
      const access = await workbenchFileAccess(
        context,
        prepared.objectId,
        tx,
        true,
      );
      if (!access?.canMaintain)
        throw new DataAccessError('authorization_denied');
      const [current] =
        await tx`select state from allrice_storage_objects where id=${prepared.objectId} for update`;
      if (current?.state === 'pending')
        await markStorageReady(context, prepared.objectId, tx);
      else if (current?.state !== 'ready')
        throw new DataAccessError('not_found');
    });
  }
  return { objectId: prepared.objectId };
}

/** Reservation binds current authority atomically; byte copying holds no DB transaction. */
async function snapshotFile(
  context: RequestContext,
  file: Awaited<ReturnType<typeof readWorkbenchFile>>,
  requestId: string,
  storage: StoragePort,
) {
  if (file.row.legacy_company_asset_id)
    throw new WorkbenchFileError(
      'invalid_file',
      '请通过已发布资料的原入口使用这个固定版本。',
    );
  const existingSource = file.policy?.reference_source_id ?? file.row.source_id;
  if (existingSource) {
    const revisions = await listReferenceRevisions(
      context,
      context.workspaceId!,
      existingSource,
    );
    const exact = revisions.find(
      (reference) =>
        reference.status === 'active' &&
        reference.checksum === file.object.checksum,
    );
    if (exact) {
      const existing = await getReferenceFile(
        context,
        context.workspaceId!,
        exact.revisionId,
      );
      return {
        sourceId: exact.sourceId,
        revisionId: exact.revisionId,
        object: existing.object,
        alreadyReady: true,
      };
    }
  }
  if (file.object.sizeBytes > 50 * 1024 * 1024)
    throw new WorkbenchFileError(
      'invalid_file',
      '这个文件超过长期参考的上传容量，请先拆分资料。',
    );
  const bytes = new Uint8Array(
    await new Response(await storage.get(file.object)).arrayBuffer(),
  );
  if (
    bytes.byteLength !== file.object.sizeBytes ||
    digest(bytes) !== file.object.checksum
  )
    throw new WorkbenchFileError(
      'invalid_file',
      '文件内容校验未通过，请重新读取。',
    );
  const prepared = await prepareReferenceUpload(
    context,
    {
      workspaceId: context.workspaceId!,
      requestId,
      scope: 'personal',
      fileName: file.row.file_name.slice(0, 160),
      purpose: '',
      mediaType: file.object.mediaType,
      contentBase64: Buffer.from(bytes).toString('base64'),
    },
    { originObjectId: file.object.id },
  );
  if (!prepared.alreadyReady) {
    await storage.put(
      prepared.object,
      new Blob([new Uint8Array(prepared.bytes)]).stream(),
    );
    await completeReferenceUpload(
      context,
      context.workspaceId!,
      prepared.revisionId,
    );
  }
  return prepared;
}

function legacySharing(
  file: Awaited<ReturnType<typeof readWorkbenchFile>>,
): WorkbenchFileSharing {
  const ownership = file.row.source_ownership
    ? ContentOwnershipSchema.parse(file.row.source_ownership)
    : null;
  if (ownership?.scope === 'company')
    return { scope: 'company', departmentIds: [] };
  if (ownership?.scope === 'department')
    return { scope: 'departments', departmentIds: [ownership.departmentId] };
  // Preserve the exact workspace read boundary until a new range is chosen.
  return { scope: 'personal', departmentIds: [] };
}

export async function updateWorkbenchFile(
  contextInput: RequestContext,
  objectId: string,
  input: unknown,
  storage: StoragePort,
) {
  const value = WorkbenchFileUpdateSchema.parse(input),
    context = scoped(contextInput, value.workspaceId),
    db = getDatabase();
  const inputDigest = digest(JSON.stringify({ objectId, ...value }));
  const initial = await readWorkbenchFile(context, objectId);
  if (!initial.canMaintain) throw new DataAccessError('authorization_denied');
  const [completed] = await db<
    { object_id: string; input_digest: string; result_revision: number }[]
  >`
    select object_id,input_digest,result_revision from allrice_workbench_file_mutations
    where organization_id=${context.organizationId} and actor_id=${context.actor.id} and request_id=${value.requestId}`;
  if (completed) {
    if (
      completed.object_id !== objectId ||
      completed.input_digest !== inputDigest
    )
      throw new WorkbenchFileError(
        'request_conflict',
        '请求内容已变化，请重新读取后操作。',
      );
    return { objectId, revision: completed.result_revision };
  }
  if ((initial.policy?.revision ?? 0) !== value.expectedRevision)
    throw new WorkbenchFileError(
      'version_conflict',
      '文件设置已变化，请刷新后再保存。',
    );
  const referenceCopy =
    value.isReference === true
      ? await snapshotFile(context, initial, value.requestId, storage)
      : null;
  return db.begin(async (tx) => {
    await readContentPrincipal(context, tx, true);
    // Every version of a deliverable uses the same lock key.
    await tx`select pg_advisory_xact_lock(hashtextextended(${context.organizationId + '/file/' + (initial.row.series_id ?? objectId)},0))`;
    const file = await readWorkbenchFile(context, objectId, tx);
    if (!file.canMaintain) throw new DataAccessError('authorization_denied');
    const prior = await readWorkbenchFilePolicy(objectId, tx, 'update');
    const [receipt] = await tx<
      { object_id: string; input_digest: string; result_revision: number }[]
    >`
      select * from allrice_workbench_file_mutations
      where organization_id=${context.organizationId} and actor_id=${context.actor.id} and request_id=${value.requestId}`;
    if (receipt) {
      if (
        receipt.object_id !== objectId ||
        receipt.input_digest !== inputDigest
      )
        throw new WorkbenchFileError(
          'request_conflict',
          '请求内容已变化，请重新读取后操作。',
        );
      return { objectId, revision: receipt.result_revision };
    }
    if ((prior?.revision ?? 0) !== value.expectedRevision)
      throw new WorkbenchFileError(
        'version_conflict',
        '文件设置已变化，请刷新后再保存。',
      );
    if (
      !prior &&
      !value.sharing &&
      !file.row.source_id &&
      file.row.visibility !== 'private'
    )
      throw new WorkbenchFileError(
        'invalid_file',
        '请先明确这个共享文件的可见范围，再设置长期参考。',
      );
    const sharing =
      value.sharing ??
      (prior
        ? { scope: prior.scope, departmentIds: prior.department_ids }
        : legacySharing(file));
    await validateTarget(context, file.row.owner_id, sharing, tx);
    const canonicalId = prior?.object_id ?? objectId;
    const referenceSourceId =
      referenceCopy?.sourceId ??
      prior?.reference_source_id ??
      file.row.source_id ??
      null;
    if (!prior) {
      await tx`insert into allrice_workbench_file_policies
        (object_id,organization_id,workspace_id,owner_id,series_id,file_name,scope,department_ids,reference_source_id,reference_enabled)
        values (${canonicalId},${file.row.organization_id},${file.row.workspace_id},${file.row.owner_id},${file.row.series_id},${file.row.file_name},${sharing.scope},${sharing.departmentIds},${referenceSourceId},false)`;
    }
    if (referenceSourceId)
      await tx`insert into allrice_workbench_reference_bindings(source_id,origin_object_id,organization_id)
        values (${referenceSourceId},${objectId},${context.organizationId}) on conflict (source_id) do nothing`;
    const revision = (prior?.revision ?? 0) + 1;
    await tx`update allrice_workbench_file_policies set scope=${sharing.scope},department_ids=${sharing.departmentIds},
      reference_source_id=${referenceSourceId},reference_enabled=${value.isReference ?? prior?.reference_enabled ?? !!file.row.source_id},
      revision=${revision},updated_at=clock_timestamp() where object_id=${canonicalId}`;
    // Old APIs and previously issued URLs must not preserve broader access.
    await tx`update allrice_storage_objects set visibility='private',updated_at=clock_timestamp()
      where id=${objectId} or (${file.row.series_id}::uuid is not null and id in
        (select object_id from allrice_deliverable_versions where series_id=${file.row.series_id} and organization_id=${context.organizationId}))`;
    await tx`update allrice_storage_access_grants set revoked_at=clock_timestamp()
      where revoked_at is null and (object_id=${objectId} or (${file.row.series_id}::uuid is not null and object_id in
        (select object_id from allrice_deliverable_versions where series_id=${file.row.series_id} and organization_id=${context.organizationId})))`;
    await tx`insert into allrice_workbench_file_mutations(organization_id,actor_id,request_id,object_id,input_digest,result_revision)
      values (${context.organizationId},${context.actor.id},${value.requestId},${objectId},${inputDigest},${revision})`;
    await auditFile(
      context,
      objectId,
      file.row.workspace_id,
      'workbench.file.update',
      revision,
      tx,
    );
    return { objectId, revision };
  });
}

/** Prepare an exact, permission-bound reference. Processing status remains
 * truthful; the client selects it only after the existing processor is ready. */
export async function captureWorkbenchFileReference(
  contextInput: RequestContext,
  workspaceId: string,
  objectId: string,
  requestId: string,
  storage: StoragePort,
) {
  const context = scoped(contextInput, workspaceId);
  UuidSchema.parse(requestId);
  const file = await readWorkbenchFile(context, objectId);
  const copy = await snapshotFile(context, file, requestId, storage);
  const references = await listReferenceRevisions(
    context,
    workspaceId,
    copy.sourceId,
  );
  const reference = references.find((r) => r.revisionId === copy.revisionId);
  if (!reference) throw new DataAccessError('not_found');
  return reference;
}

export async function readWorkbenchFileCatalog(
  contextInput: RequestContext,
  input: {
    workspaceId: string;
    sessionId?: string | null;
    scope?: string;
    query?: string;
  },
) {
  const context = scoped(contextInput, input.workspaceId),
    db = getDatabase();
  const principal = await readContentPrincipal(context);
  if (!principal) throw new DataAccessError('authorization_denied');
  if (input.sessionId)
    await db.begin((tx) =>
      assertWorkbenchSession(tx, context, input.sessionId!),
    );
  const options = await referenceLibraryOptions(context, input.workspaceId);
  const pattern = '%' + (input.query ?? '').slice(0, 200) + '%';
  const rows = await db<{ id: string }[]>`
    select o.id from allrice_storage_objects o
    left join lateral (select series_id,file_name,version from allrice_deliverable_versions where object_id=o.id order by version desc limit 1) d on true
    left join allrice_workbench_file_policies p on p.object_id=o.id or (d.series_id is not null and p.series_id=d.series_id)
    left join lateral (select file_name from allrice_file_references where object_id=o.id order by created_at desc limit 1) f on true
    where o.organization_id=${context.organizationId} and o.state='ready' and o.deleted_at is null and (o.category in ('uploads','exports') or (o.category='artifacts' and d.series_id is not null))
      and (o.workspace_id=${input.workspaceId} or p.scope in ('departments','company'))
      and (o.owner_id=${context.actor.id} or o.visibility<>'private' or p.scope='company'
        or (p.scope='departments' and (${principal.maintenanceLevel === 'company'} or ${principal.departmentId}::uuid=any(p.department_ids))))
      and (${input.scope !== 'my'} or o.owner_id=${context.actor.id})
      and (${input.scope !== 'current'} or exists(select 1 from allrice_file_references f where f.object_id=o.id and f.session_id=${input.sessionId ?? null})
        or exists(select 1 from allrice_deliverable_versions v where v.object_id=o.id and v.session_id=${input.sessionId ?? null}))
      and (${input.scope !== 'departments'} or p.scope='departments')
      and (${input.scope !== 'company'} or p.scope='company' or (p.object_id is null and o.visibility='organization'))
      and coalesce(d.file_name,f.file_name,p.file_name,'未命名文件') ilike ${pattern}
      and not exists(select 1 from allrice_knowledge_revisions r where r.file_object_id=o.id)
      and not exists(select 1 from allrice_company_asset_revisions r where r.snapshot_object_id=o.id)
      and not exists(select 1 from allrice_company_asset_materials m where m.object_id=o.id)
      and not exists(select 1 from allrice_company_run_assets r where r.material_object_id=o.id)
      and (d.series_id is null or not exists(select 1 from allrice_deliverable_versions newer
        join allrice_storage_objects ready on ready.id=newer.object_id and ready.state='ready' and ready.deleted_at is null
        where newer.series_id=d.series_id and newer.version>d.version))
    order by o.created_at desc,o.id limit 201`;
  const references = await listReferenceRevisions(
    context,
    input.workspaceId,
    undefined,
    true,
  );
  const candidates = new Map(
    rows.map((row) => [row.id, null as WorkbenchFile['reference']]),
  );
  const referenceBySource = new Map(references.map((r) => [r.sourceId, r]));
  for (const ref of references) {
    if (
      ref.status !== 'active' ||
      !ref.fileName
        .toLocaleLowerCase()
        .includes((input.query ?? '').toLocaleLowerCase())
    )
      continue;
    try {
      const file = await getReferenceFile(
        context,
        input.workspaceId,
        ref.revisionId,
      );
      const [binding] = await db<
        { origin_object_id: string }[]
      >`select origin_object_id from allrice_workbench_reference_bindings where source_id=${ref.sourceId}`;
      const id = binding?.origin_object_id ?? file.object.id;
      const policy = await readWorkbenchFilePolicy(id, db);
      if (binding && policy?.reference_source_id !== ref.sourceId) continue;
      if (binding) {
        const origin = await readWorkbenchFile(context, id);
        if (origin.row.series_id) {
          const [latest] = await db<
            { object_id: string }[]
          >`select v.object_id from allrice_deliverable_versions v
            join allrice_storage_objects o on o.id=v.object_id and o.state='ready' and o.deleted_at is null
            where v.series_id=${origin.row.series_id} order by v.version desc limit 1`;
          if (latest) {
            candidates.set(latest.object_id, ref);
            continue;
          }
        }
      }
      candidates.set(id, ref);
    } catch (error) {
      if (error instanceof DataAccessError) continue;
      throw error;
    }
  }
  const result: WorkbenchFile[] = [];
  for (const [objectId, reference] of candidates) {
    try {
      const file = await readWorkbenchFile(context, objectId),
        p = file.policy;
      const [associated] = input.sessionId
        ? await db<{ present: boolean }[]>`
        select exists(select 1 from allrice_file_references where object_id=${objectId} and session_id=${input.sessionId}
          union all select 1 from allrice_deliverable_versions where object_id=${objectId} and session_id=${input.sessionId}) as present`
        : [];
      const ownership = file.row.source_ownership
        ? ContentOwnershipSchema.parse(file.row.source_ownership)
        : reference?.ownership;
      const scope =
        p?.scope ??
        (ownership?.scope === 'platform'
          ? 'platform'
          : ownership?.scope === 'company'
            ? 'company'
            : ownership?.scope === 'department'
              ? 'departments'
              : file.row.visibility === 'organization'
                ? 'company'
                : file.row.visibility === 'workspace'
                  ? 'workspace'
                  : 'personal');
      const departmentIds =
        p?.department_ids ??
        (ownership?.scope === 'department' ? [ownership.departmentId] : []);
      const departmentRows = departmentIds.length
        ? await db<
            { id: string; name: string }[]
          >`select id,name from allrice_departments where id in ${db(departmentIds)} and organization_id=${context.organizationId} and archived_at is null order by name`
        : [];
      const owned = file.row.owner_id === context.actor.id;
      if (input.scope === 'current' && !associated?.present) continue;
      if (input.scope === 'my' && !owned) continue;
      if (input.scope === 'departments' && scope !== 'departments') continue;
      if (input.scope === 'company' && scope !== 'company') continue;
      const isReference = p ? p.reference_enabled : !!reference;
      result.push(
        WorkbenchFileSchema.parse({
          objectId,
          workspaceId: file.object.workspaceId,
          fileName: file.row.file_name,
          mediaType: file.object.mediaType,
          checksum: file.object.checksum,
          sizeBytes: file.object.sizeBytes,
          createdAt: file.row.created_at.toISOString(),
          ownedByMe: owned,
          canMaintain: file.canMaintain,
          revision: p?.revision ?? 0,
          sharing: {
            scope,
            departmentIds,
            departmentNames: departmentRows.map((d) => d.name),
          },
          category:
            file.row.artifact_id && file.row.business_deliverable
              ? 'artifact'
              : file.row.source_id
                ? 'reference'
                : 'upload',
          sessionIds:
            associated?.present && input.sessionId ? [input.sessionId] : [],
          artifact:
            file.row.artifact_id &&
            file.row.business_deliverable &&
            file.row.artifact_session_id &&
            file.row.artifact_session_owner === context.actor.id
              ? {
                  id: file.row.artifact_id,
                  sessionId: file.row.artifact_session_id,
                  version: file.row.artifact_version,
                }
              : null,
          isReference,
          reference: isReference
            ? p?.reference_source_id
              ? (referenceBySource.get(p.reference_source_id) ?? null)
              : reference
            : null,
        }),
      );
    } catch (error) {
      if (error instanceof DataAccessError) continue;
      throw error;
    }
  }
  result.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.objectId.localeCompare(a.objectId),
  );
  return {
    files: result.slice(0, 200),
    truncated: rows.length > 200 || result.length > 200,
    options: {
      writable: options.writable,
      maintenanceLevel: options.maintenanceLevel,
      departmentId: options.departmentId,
      departments: options.departments,
    },
  };
}

/** A file-only history deliberately omits private Session/Run/owner metadata. */
export async function listWorkbenchFileVersions(
  context: RequestContext,
  objectId: string,
) {
  const file = await readWorkbenchFile(context, objectId),
    db = getDatabase();
  if (!file.row.series_id) return [];
  const rows = await db<
    {
      id: string;
      object_id: string;
      file_name: string;
      version: number;
      created_at: Date;
    }[]
  >`
    select v.id,v.object_id,v.file_name,v.version,v.created_at from allrice_deliverable_versions v
    join allrice_storage_objects o on o.id=v.object_id and o.state='ready' and o.deleted_at is null
    where v.series_id=${file.row.series_id} and v.organization_id=${context.organizationId}
    order by v.version desc limit 200`;
  const result = [];
  for (const row of rows) {
    try {
      await readWorkbenchFile(context, row.object_id);
      result.push({
        id: row.id,
        objectId: row.object_id,
        fileName: row.file_name,
        version: row.version,
        createdAt: row.created_at.toISOString(),
      });
    } catch (error) {
      if (!(error instanceof DataAccessError)) throw error;
    }
  }
  return result;
}
