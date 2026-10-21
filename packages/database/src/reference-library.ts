import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import type { OrganizationSharedReader } from './organization-shared-reader.ts';
import {
  ContentOwnershipSchema,
  ReferenceActionSchema,
  ReferenceArtifactSaveInputSchema,
  ReferenceRevisionSchema,
  ReferenceUploadInputSchema,
  UuidSchema,
  MembershipSchema,
  type ContentOwnership,
  type ReferenceRevision,
  type ReferenceUploadInput,
  type StoragePort,
  type RequestContext,
  type StorageObject,
} from '@allrice/contracts';
import {
  assertWorkbenchSession,
  readArtifact,
  readArtifactBytes,
} from './artifact-review.ts';
import { businessDeliverablePredicate } from './organization-dashboard.ts';
import { getDatabase } from './core/client.ts';
import { isIndexableKnowledgeTextSource } from './memory/knowledge-retrieval.ts';
import { isPlatformAdmin } from './providers/model-pool.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { createStorageMetadata, DataAccessError } from './data.ts';
import {
  getContentAccess,
  readContentPrincipal,
  type ContentIdentity,
} from './content-maintenance.ts';
import {
  legacyReferenceAuthority,
  assertLegacyReferenceRevision,
} from './reference-company-templates.ts';
import {
  workbenchReferenceAccess,
  workbenchFileSchemaReady,
  workbenchOriginFileAccess,
} from './workbench-file-access.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
export class ReferenceLibraryError extends Error {
  constructor(
    public readonly code:
      | 'version_conflict'
      | 'request_conflict'
      | 'invalid_content'
      | 'processing_busy'
      | 'source_unavailable',
  ) {
    super(code);
  }
}
interface SourceRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  ownership: ContentOwnership;
  status: 'active' | 'archived';
  legacy_company_asset_id: string | null;
}
interface FileRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  object_key: string;
  checksum: StorageObject['checksum'];
  media_type: string;
  size_bytes: number | string;
  state: string;
  retention_until: Date | null;
  deleted_at: Date | null;
  immutable: boolean;
}
function object(row: FileRow): StorageObject {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    key: row.object_key as StorageObject['key'],
    checksum: row.checksum,
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    retentionUntil: row.retention_until?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    immutable: row.immutable,
  };
}
function scoped(context: RequestContext, workspaceId: string) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  if (context.workspaceId && context.workspaceId !== workspaceId)
    throw new DataAccessError('authorization_denied');
  return { ...context, workspaceId: UuidSchema.parse(workspaceId) };
}

/** Platform content stays in the administrator's actual control-plane namespace.
 * This is not an admin override for any tenant's private or shared content. */
async function platformReferenceMaintainer(context: ContentIdentity, sql: Sql) {
  if (
    !context.sessionId ||
    !context.workspaceId ||
    !(await isPlatformAdmin(context, sql))
  )
    return false;
  const [row] = await sql`select w.id from allrice_workspaces w
    join allrice_organizations o on o.id=w.organization_id and o.slug='allrice-platform' and o.archived_at is null
    where w.id=${context.workspaceId} and w.organization_id=${context.organizationId}
      and w.slug='control-plane' and w.archived_at is null`;
  return !!row;
}
async function referenceAccess(
  context: ContentIdentity,
  ownership: ContentOwnership,
  sql: Sql,
  maintain = false,
  lockRead = false,
) {
  const access = await getContentAccess(
    context,
    ownership,
    sql,
    maintain || lockRead,
  );
  if (
    ownership.scope === 'platform' &&
    access.canRead &&
    (await readContentPrincipal(context, sql))?.writable &&
    (await platformReferenceMaintainer(context, sql))
  )
    return {
      ...access,
      canMaintain: true,
      maintenanceReason: 'allowed' as const,
    };
  return access;
}

/** A single current-authority boundary for the new ownership model. Legacy
 * sources keep their existing workspace and immutable ACL checks. */
export async function referenceSourceAccess(
  context: ContentIdentity,
  sourceId: string,
  sql: Sql = getDatabase(),
  maintain = false,
  lockRead = false,
  allowLegacyProcessing = false,
  sharedReader?: OrganizationSharedReader,
) {
  if (sharedReader && (maintain || lockRead || allowLegacyProcessing))
    throw new DataAccessError('authorization_denied');
  if (maintain || lockRead) await readContentPrincipal(context, sql, true);
  const legacy = await legacyReferenceAuthority(
    sql,
    UuidSchema.parse(sourceId),
    maintain || lockRead,
  );
  // Publication controls (including private-draft protection) remain in the
  // existing company asset API, never a second set of Knowledge mutations.
  if (legacy && maintain && !allowLegacyProcessing)
    throw new DataAccessError('not_found');
  const boundAccess =
    !sharedReader && !legacy
      ? await workbenchReferenceAccess(
          context,
          sourceId,
          sql,
          maintain || lockRead,
        )
      : null;
  const [s] = await sql<
    SourceRow[]
  >`select id,organization_id,workspace_id,ownership,status,legacy_company_asset_id
    from allrice_knowledge_sources where id=${UuidSchema.parse(sourceId)} and ownership is not null
    ${maintain ? sql`for update` : lockRead ? sql`for share` : sql``}`;
  if (!s) throw new DataAccessError('not_found');
  const ownership = ContentOwnershipSchema.parse(s.ownership);
  const baseAccess = sharedReader
    ? sharedReader.access(ownership)
    : await referenceAccess(context, ownership, sql, maintain, lockRead);
  const access = boundAccess ? { ...baseAccess, ...boundAccess } : baseAccess;
  if (!access.canRead || (maintain && !access.canMaintain))
    throw new DataAccessError('not_found');
  return {
    source: s,
    ownership,
    access: legacy ? { ...access, canMaintain: false } : access,
    legacy,
  };
}

export async function listReferenceRevisions(
  contextInput: RequestContext,
  workspaceId: string,
  sourceId?: string,
  includeManagedFiles = false,
): Promise<ReferenceRevision[]> {
  const context = scoped(contextInput, workspaceId),
    sql = getDatabase();
  if (!(await readContentPrincipal(context)))
    throw new DataAccessError('authorization_denied');
  const sources = await sql<
    SourceRow[]
  >`select s.id,s.organization_id,s.workspace_id,s.ownership,s.status,s.legacy_company_asset_id from allrice_knowledge_sources s
    left join allrice_company_assets a on a.id=s.legacy_company_asset_id
    where s.ownership is not null and (s.organization_id=${context.organizationId} or s.ownership->>'scope'='platform')
    and (s.legacy_company_asset_id is null or a.state='published')
    and (${sourceId ?? null}::uuid is null or s.id=${sourceId ?? null}) order by s.updated_at desc,s.id`;
  const result: ReferenceRevision[] = [];
  for (const s of sources) {
    const ownership = ContentOwnershipSchema.parse(s.ownership),
      baseAccess = await referenceAccess(context, ownership, sql),
      boundAccess = !s.legacy_company_asset_id
        ? await workbenchReferenceAccess(context, s.id, sql)
        : null,
      access = boundAccess ? { ...baseAccess, ...boundAccess } : baseAccess;
    if (!access.canRead || (s.status === 'archived' && !access.canMaintain))
      continue;
    if (
      !sourceId &&
      !includeManagedFiles &&
      (await workbenchFileSchemaReady(sql))
    ) {
      const [managed] =
        await sql`select b.source_id,p.reference_enabled,p.reference_source_id
        from allrice_workbench_reference_bindings b
        left join allrice_workbench_file_policies p on p.object_id=b.origin_object_id
          or p.series_id in (select d.series_id from allrice_deliverable_versions d where d.object_id=b.origin_object_id)
        where b.source_id=${s.id}`;
      if (
        managed &&
        (!managed.reference_enabled || managed.reference_source_id !== s.id)
      )
        continue;
    }
    const rows =
      await sql`select r.id,r.revision,r.file_name,r.description,r.created_at,r.artifact_snapshot,r.checksum as manifest_digest,o.checksum,o.size_bytes,o.media_type,
      r.legacy_company_revision_id,cr.digest as company_digest,
      p.state,p.failure,o.state as file_state from allrice_knowledge_revisions r join allrice_storage_objects o on o.id=r.file_object_id
      join allrice_knowledge_processing p on p.revision_id=r.id
      left join allrice_company_assets a on a.id=r.legacy_company_asset_id
      left join allrice_company_asset_publications cp on cp.asset_id=a.id and cp.revision_id=r.legacy_company_revision_id
      left join allrice_company_asset_revisions cr on cr.id=cp.revision_id
      where r.knowledge_source_id=${s.id} and r.status='published'
      and (r.legacy_company_revision_id is null or (a.state='published' and cp.revision_id is not null
        and (${!!sourceId} or cp.revision_id=a.published_revision_id)))
      order by r.revision desc ${sourceId ? sql`` : sql`limit 1`}`;
    for (const r of rows)
      result.push(
        ReferenceRevisionSchema.parse({
          sourceId: s.id,
          revisionId: r.id,
          revision: r.revision,
          ownership,
          fileName: r.file_name,
          purpose: r.description,
          checksum: r.checksum,
          manifestDigest: r.manifest_digest,
          sizeBytes: Number(r.size_bytes),
          mediaType: r.media_type,
          status: s.status,
          processing: r.file_state === 'pending' ? 'uploading' : r.state,
          failure: r.failure,
          canMaintain: !s.legacy_company_asset_id && access.canMaintain,
          canRetryProcessing:
            access.canMaintain &&
            (r.state !== 'unsupported' ||
              isIndexableKnowledgeTextSource({
                mediaType: r.media_type,
                sizeBytes: Number(r.size_bytes),
              })),
          createdAt: r.created_at.toISOString(),
          ...(s.legacy_company_asset_id
            ? {
                companyTemplate: {
                  assetId: s.legacy_company_asset_id,
                  revisionId: r.legacy_company_revision_id,
                  digest: r.company_digest,
                },
              }
            : {}),
          origin: r.artifact_snapshot
            ? {
                fileName: r.artifact_snapshot.fileName,
                version: r.artifact_snapshot.version,
                checksum: r.artifact_snapshot.checksum,
              }
            : null,
        }),
      );
  }
  return result;
}

export async function getReferenceFile(
  contextInput: RequestContext,
  workspaceId: string,
  revisionId: string,
  sql: Sql = getDatabase(),
  sharedReader?: OrganizationSharedReader,
) {
  const context = scoped(contextInput, workspaceId);
  const [r] = await sql<
    { knowledge_source_id: string; file_name: string; file_object_id: string }[]
  >`select knowledge_source_id,file_name,file_object_id
    from allrice_knowledge_revisions where id=${UuidSchema.parse(revisionId)} and file_object_id is not null and status='published'`;
  if (!r) throw new DataAccessError('not_found');
  const { source, legacy } = await referenceSourceAccess(
    context,
    r.knowledge_source_id,
    sql,
    false,
    false,
    false,
    sharedReader,
  );
  if (source.status !== 'active') throw new DataAccessError('not_found');
  if (legacy) await assertLegacyReferenceRevision(sql, revisionId, legacy.id);
  const [o] = await sql<
    FileRow[]
  >`select * from allrice_storage_objects where id=${r.file_object_id} and state='ready' and deleted_at is null`;
  if (!o) throw new DataAccessError('not_found');
  return { object: object(o), fileName: r.file_name, sourceId: source.id };
}

export async function prepareReferenceUpload(
  contextInput: RequestContext,
  input: unknown,
  binding?: { originObjectId: string },
) {
  const v = ReferenceUploadInputSchema.parse(input),
    context = scoped(contextInput, v.workspaceId);
  if (context.actor.type !== 'user')
    throw new DataAccessError('authentication_required');
  const { contentBase64, ...metadata } = v;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length % 4)
    throw new ReferenceLibraryError('invalid_content');
  const bytes = Buffer.from(contentBase64, 'base64');
  if (bytes.length === 0 || bytes.length > 50 * 1024 * 1024)
    throw new ReferenceLibraryError('invalid_content');
  const checksum =
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` as StorageObject['checksum'];
  const ownership = referenceOwnership(context, v);
  const requestInput = {
    ...metadata,
    checksum,
    sizeBytes: bytes.length,
    ...(binding
      ? { originObjectId: UuidSchema.parse(binding.originObjectId) }
      : {}),
  };
  const result = await getDatabase().begin(async (tx) => {
    await lockWorkspaceStorageQuota(tx, context.organizationId, v.workspaceId);
    if (!(await referenceAccess(context, ownership, tx, true)).canMaintain)
      throw new DataAccessError('authorization_denied');
    if (
      binding &&
      !(
        await workbenchOriginFileAccess(
          context,
          binding.originObjectId,
          tx,
          true,
        )
      ).canRead
    )
      throw new DataAccessError('authorization_denied');
    // A prior reader that knows only ContentOwnership must fail closed for a
    // shared recipient's copy. Its private fallback belongs to the original
    // file owner, never to the copy creator. The binding grants current reads.
    let sourceOwnership = ownership;
    if (binding) {
      if (v.sourceId || v.scope !== 'personal')
        throw new ReferenceLibraryError('invalid_content');
      const [origin] = await tx<
        { owner_id: string }[]
      >`select owner_id from allrice_storage_objects
        where id=${binding.originObjectId} and organization_id=${context.organizationId} for share`;
      if (!origin) throw new DataAccessError('not_found');
      sourceOwnership = {
        scope: 'personal',
        organizationId: context.organizationId,
        ownerId: origin.owner_id,
      };
    }
    await lockReferenceRequest(tx, context, v.requestId);
    const prior = await findReferenceRequest(
      tx,
      context,
      v.requestId,
      'upload',
      requestInput,
    );
    if (prior) return readReferenceReservation(tx, context, prior, binding);
    const saved = await reserveReferenceFile(
      tx,
      context,
      v,
      sourceOwnership,
      checksum,
      bytes.length,
      requestInput,
    );
    if (binding)
      await tx`insert into allrice_workbench_reference_bindings(source_id,origin_object_id,organization_id)
        values (${saved.sourceId},${binding.originObjectId},${context.organizationId})`;
    await recordReferenceRequest(
      tx,
      context,
      v.requestId,
      'upload',
      requestInput,
      saved.revisionId,
    );
    return saved;
  });
  return { ...result, bytes };
}

function referenceOwnership(
  context: RequestContext,
  v: Pick<ReferenceUploadInput, 'scope' | 'departmentId'>,
): ContentOwnership {
  return v.scope === 'platform'
    ? { scope: 'platform' }
    : v.scope === 'personal'
      ? {
          scope: 'personal',
          organizationId: context.organizationId,
          ownerId: context.actor.id,
        }
      : v.scope === 'department'
        ? {
            scope: 'department',
            organizationId: context.organizationId,
            departmentId: v.departmentId!,
          }
        : { scope: 'company', organizationId: context.organizationId };
}
type ReferenceFileInput = Omit<ReferenceUploadInput, 'contentBase64'>;
type ArtifactOrigin = {
  versionId: string;
  targetKey: string;
  snapshot: Record<string, string | number>;
};

/** Internal common reservation: callers already hold quota, current authority
 * and request/source locks. All reference entrypoints use the same retention,
 * immutable publication and processing queue. */
async function reserveReferenceFile(
  tx: postgres.TransactionSql,
  context: RequestContext,
  v: ReferenceFileInput,
  ownership: ContentOwnership,
  checksum: StorageObject['checksum'],
  sizeBytes: number,
  requestInput: postgres.JSONValue,
  origin?: ArtifactOrigin,
) {
  let source: SourceRow,
    revision = 1;
  if (v.sourceId) {
    const found = await referenceSourceAccess(context, v.sourceId, tx, true);
    source = found.source;
    if (
      !isDeepStrictEqual(found.ownership, ownership) ||
      source.status !== 'active'
    )
      throw new DataAccessError('not_found');
    const [latest] =
      await tx`select max(revision)::int value from allrice_knowledge_revisions where knowledge_source_id=${source.id}`;
    if (!latest || latest.value !== v.expectedRevision)
      throw new ReferenceLibraryError('version_conflict');
    revision = latest.value + 1;
  } else {
    const id = randomUUID();
    const [created] = await tx<
      SourceRow[]
    >`insert into allrice_knowledge_sources
        (id,organization_id,workspace_id,slug,name,description,created_by,ownership)
        values (${id},${context.organizationId},${v.workspaceId},${'reference-' + id},${v.fileName},${v.purpose || '参考资料'},${context.actor.id},${tx.json(ownership)}) returning *`;
    source = created!;
  }
  // Resolve actual current memberships. Platform sessions intentionally omit
  // them from the browser context; never manufacture a tenant membership.
  const rows =
    await tx`select id,user_id,organization_id,workspace_id,role,active from allrice_memberships
      where organization_id=${context.organizationId} and user_id=${context.actor.id} and active
        and (workspace_id is null or workspace_id=${v.workspaceId})`;
  const storageContext = {
    ...context,
    memberships: rows.map((m) =>
      MembershipSchema.parse({
        id: m.id,
        userId: m.user_id,
        organizationId: m.organization_id,
        workspaceId: m.workspace_id,
        role: m.role,
        active: m.active,
      }),
    ),
  };
  const file = await createStorageMetadata(
    storageContext,
    {
      id: randomUUID(),
      workspaceId: v.workspaceId,
      category: 'uploads',
      mediaType: v.mediaType,
      sizeBytes,
      checksum,
      visibility: 'private',
      retentionUntil: null,
      immutable: true,
    },
    tx,
  );
  const definition = {
    schemaVersion: 1,
    sourceKind: 'managed',
    connectorBindingId: null,
    resourceRef: 'file:' + file.object.id,
    indexing: 'hybrid',
    updatePolicy: 'manual',
    citationRequired: true,
    allowedScopes: [v.scope === 'personal' ? 'user' : 'organization'],
  };
  const digest = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        definition,
        checksum,
        ownership,
        name: v.fileName,
        purpose: v.purpose,
      }),
    )
    .digest('hex')}`;
  const [r] =
    await tx`insert into allrice_knowledge_revisions (organization_id,workspace_id,knowledge_source_id,revision,name,description,status,definition,checksum,created_by,file_object_id,file_name,request_id,request_input,source_artifact_version_id,source_target_key,artifact_snapshot)
      values (${source.organization_id},${source.workspace_id},${source.id},${revision},${v.fileName},${v.purpose || '参考资料'},'draft',${tx.json(definition)},${digest},${context.actor.id},${file.object.id},${v.fileName},${v.requestId},${tx.json(requestInput)},${origin?.versionId ?? null},${origin?.targetKey ?? null},${origin ? tx.json(origin.snapshot) : null}) returning id`;
  if (!r) throw new Error('Reference revision insertion failed');
  await tx`update allrice_knowledge_revisions set status='published',published_at=clock_timestamp() where id=${r.id}`;
  await tx`insert into allrice_knowledge_processing(revision_id) values(${r.id})`;
  await tx`update allrice_knowledge_sources set name=${v.fileName},description=${v.purpose || '参考资料'},updated_at=clock_timestamp() where id=${source.id}`;
  await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
      values (${context.organizationId},${v.workspaceId},${context.actor.id},'knowledge.reference.save','knowledge_revision',${r.id},'allowed','scoped_immutable_file',${context.requestId})`;
  return {
    revisionId: r.id as string,
    sourceId: source.id,
    object: file.object,
    alreadyReady: false,
  };
}
async function lockReferenceRequest(
  tx: postgres.TransactionSql,
  context: RequestContext,
  requestId: string,
) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${context.organizationId + ':reference:' + context.actor.id + ':' + requestId},0))`;
}
async function findReferenceRequest(
  tx: postgres.TransactionSql,
  context: RequestContext,
  requestId: string,
  operation: 'upload' | 'artifact',
  input: unknown,
) {
  const [prior] =
    await tx`select operation,input,revision_id from allrice_knowledge_save_requests
    where organization_id=${context.organizationId} and actor_id=${context.actor.id} and request_id=${requestId}`;
  if (!prior) return null;
  if (prior.operation !== operation || !isDeepStrictEqual(prior.input, input))
    throw new ReferenceLibraryError('request_conflict');
  return prior.revision_id as string;
}
async function recordReferenceRequest(
  tx: postgres.TransactionSql,
  context: RequestContext,
  requestId: string,
  operation: 'upload' | 'artifact',
  input: postgres.JSONValue,
  revisionId: string,
) {
  await tx`insert into allrice_knowledge_save_requests(organization_id,actor_id,request_id,operation,input,revision_id)
    values(${context.organizationId},${context.actor.id},${requestId},${operation},${tx.json(input)},${revisionId})`;
}
async function readReferenceReservation(
  tx: postgres.TransactionSql,
  context: RequestContext,
  revisionId: string,
  binding?: { originObjectId: string },
) {
  const [r] =
    await tx`select knowledge_source_id,file_object_id,source_artifact_version_id,created_by,workspace_id from allrice_knowledge_revisions where id=${revisionId}`;
  if (!r) throw new DataAccessError('not_found');
  if (
    r.source_artifact_version_id &&
    (r.created_by !== context.actor.id ||
      r.workspace_id !== context.workspaceId)
  )
    throw new ReferenceLibraryError('source_unavailable');
  const [file] = await tx<
    FileRow[]
  >`select * from allrice_storage_objects where id=${r.file_object_id}`;
  if (!file || file.deleted_at || !['pending', 'ready'].includes(file.state))
    throw new ReferenceLibraryError('invalid_content');
  // Original Session precedes target-source locks. A finished retained reference
  // no longer depends on the original file/Session lifecycle.
  if (file.state === 'pending' && r.source_artifact_version_id)
    await requireReferenceArtifact(tx, context, r.source_artifact_version_id);
  if (binding) {
    const [saved] =
      await tx`select origin_object_id from allrice_workbench_reference_bindings
      where source_id=${r.knowledge_source_id} and organization_id=${context.organizationId}`;
    if (
      r.created_by !== context.actor.id ||
      saved?.origin_object_id !== binding.originObjectId
    )
      throw new ReferenceLibraryError('request_conflict');
  }
  const { source } = await pendingReferenceUploadAccess(
    context,
    { knowledge_source_id: r.knowledge_source_id, created_by: r.created_by },
    tx,
    !!binding,
  );
  if (source.status !== 'active') throw new DataAccessError('not_found');
  return {
    revisionId,
    sourceId: source.id,
    object: object(file),
    alreadyReady: file.state === 'ready',
  };
}

/** Only a snapshot's original uploader may finish its pending reservation.
 * Read-only recipients may copy bytes they can still read, but gain no right
 * to edit a shared source or change the original file's policy. */
async function pendingReferenceUploadAccess(
  context: RequestContext,
  revision: { knowledge_source_id: string; created_by: string },
  tx: postgres.TransactionSql,
  bound: boolean,
) {
  if (bound) {
    const principal = await readContentPrincipal(context, tx, true);
    if (!principal?.writable || revision.created_by !== context.actor.id)
      throw new DataAccessError('authorization_denied');
  }
  return referenceSourceAccess(
    context,
    revision.knowledge_source_id,
    tx,
    !bound,
    bound,
  );
}

/** Call only after LocalStorageAdapter verified exact bytes. Recheck authority
 * before making them available; retry uses this same immutable request/object. */
export async function completeReferenceUpload(
  context: RequestContext,
  workspaceId: string,
  revisionId: string,
) {
  const c = scoped(context, workspaceId);
  await getDatabase().begin(async (tx) => {
    await readContentPrincipal(c, tx, true);
    const [r] =
      await tx`select knowledge_source_id,file_object_id,created_by,source_artifact_version_id from allrice_knowledge_revisions where id=${UuidSchema.parse(revisionId)}`;
    if (!r || r.created_by !== c.actor.id)
      throw new DataAccessError('not_found');
    const [file] =
      await tx`select state from allrice_storage_objects where id=${r.file_object_id}`;
    if (file?.state === 'pending' && r.source_artifact_version_id)
      await requireReferenceArtifact(tx, c, r.source_artifact_version_id);
    const bound = await workbenchReferenceAccess(
      c,
      r.knowledge_source_id,
      tx,
      true,
    );
    const { source } = await pendingReferenceUploadAccess(
      c,
      { knowledge_source_id: r.knowledge_source_id, created_by: r.created_by },
      tx,
      bound !== null,
    );
    if (source.status !== 'active') throw new DataAccessError('not_found');
    await tx`update allrice_storage_objects set state='ready',updated_at=clock_timestamp() where id=${r.file_object_id} and state='pending'`;
  });
}

/** Same business-delivery boundary as explicit company publication. Owning a
 * tool log, platform test or subassistant output does not make it shareable. */
async function requireReferenceArtifact(
  tx: postgres.TransactionSql,
  context: RequestContext,
  versionId: string,
) {
  const [candidate] =
    await tx`select session_id from allrice_deliverable_versions
    where id=${versionId} and organization_id=${context.organizationId} and workspace_id=${context.workspaceId} and owner_id=${context.actor.id} and platform_test_run_id is null`;
  if (!candidate) throw new ReferenceLibraryError('source_unavailable');
  await assertWorkbenchSession(
    tx,
    context,
    candidate.session_id,
    false,
    'share',
  );
  const [valid] = await tx`select dv.id from allrice_deliverable_versions dv
    join allrice_storage_objects o on o.id=dv.object_id and o.organization_id=dv.organization_id and o.workspace_id=dv.workspace_id and o.owner_id=dv.owner_id
    left join allrice_workbench_artifacts a on a.version_id=dv.id and a.organization_id=dv.organization_id and a.workspace_id=dv.workspace_id and a.owner_id=dv.owner_id
    where dv.id=${versionId} and dv.organization_id=${context.organizationId} and dv.workspace_id=${context.workspaceId} and dv.owner_id=${context.actor.id}
      and dv.platform_test_run_id is null and o.state='ready' and o.deleted_at is null and (o.retention_until is null or o.retention_until>clock_timestamp())
      and ${businessDeliverablePredicate(tx)}
      and exists(select 1 from allrice_employee_runs er where er.organization_id=dv.organization_id and er.workspace_id=dv.workspace_id and er.owner_id=dv.owner_id and er.session_id=dv.session_id and (a.run_id is null or a.run_id=er.run_id)
        and not exists(select 1 from allrice_assistant_instances ai where ai.run_id=er.run_id and ai.run_id<>ai.root_run_id))
    for share of dv,o`;
  if (!valid) throw new ReferenceLibraryError('source_unavailable');
  return readArtifact(tx, context, candidate.session_id, versionId);
}

export async function saveArtifactReference(
  contextInput: RequestContext,
  input: unknown,
  storage: StoragePort,
) {
  const v = ReferenceArtifactSaveInputSchema.parse(input),
    context = scoped(contextInput, v.workspaceId),
    ownership = referenceOwnership(context, v),
    targetKey =
      v.scope === 'personal'
        ? 'personal:' + context.actor.id
        : v.scope === 'department'
          ? 'department:' + v.departmentId
          : 'company:' + context.organizationId;

  // Run both before and after reading bytes. Locks do not span storage I/O.
  async function findOrReserve(
    bytes?: Buffer,
    original?: Awaited<ReturnType<typeof requireReferenceArtifact>>,
  ) {
    return getDatabase().begin(async (tx) => {
      await lockWorkspaceStorageQuota(
        tx,
        context.organizationId,
        v.workspaceId,
      );
      if (!(await referenceAccess(context, ownership, tx, true)).canMaintain)
        throw new DataAccessError('authorization_denied');
      await lockReferenceRequest(tx, context, v.requestId);
      const request = await findReferenceRequest(
        tx,
        context,
        v.requestId,
        'artifact',
        v,
      );
      await tx`select pg_advisory_xact_lock(hashtextextended(${context.organizationId + ':artifact-reference:' + v.artifactVersionId + ':' + targetKey},0))`;
      const [canonical] = await tx`select id from allrice_knowledge_revisions
        where organization_id=${context.organizationId} and source_artifact_version_id=${v.artifactVersionId} and source_target_key=${targetKey}`;
      const priorId = request ?? canonical?.id;
      if (priorId) {
        const reservation = await readReferenceReservation(
          tx,
          context,
          priorId,
        );
        if (!request)
          await recordReferenceRequest(
            tx,
            context,
            v.requestId,
            'artifact',
            v,
            priorId,
          );
        if (reservation.alreadyReady) return { reservation, artifact: null };
        const artifact = await requireReferenceArtifact(
          tx,
          context,
          v.artifactVersionId,
        );
        if (artifact.object.checksum !== reservation.object.checksum)
          throw new ReferenceLibraryError('source_unavailable');
        return { reservation, artifact };
      }
      const artifact = await requireReferenceArtifact(
        tx,
        context,
        v.artifactVersionId,
      );
      if (!bytes || !original) return { reservation: null, artifact };
      if (
        artifact.object.id !== original.object.id ||
        artifact.object.checksum !== original.object.checksum ||
        artifact.object.sizeBytes !== bytes.length
      )
        throw new ReferenceLibraryError('source_unavailable');
      const reservation = await reserveReferenceFile(
        tx,
        context,
        {
          ...v,
          fileName: artifact.version.fileName,
          mediaType: artifact.object.mediaType,
        },
        ownership,
        artifact.object.checksum,
        bytes.length,
        v,
        {
          versionId: artifact.id,
          targetKey,
          snapshot: {
            fileName: artifact.version.fileName,
            version: artifact.version.version,
            checksum: artifact.object.checksum,
            sessionId: artifact.version.sessionId!,
            ...(artifact.provenance.runId
              ? { runId: artifact.provenance.runId }
              : {}),
          },
        },
      );
      await recordReferenceRequest(
        tx,
        context,
        v.requestId,
        'artifact',
        v,
        reservation.revisionId,
      );
      return { reservation, artifact };
    });
  }
  let current = await findOrReserve();
  if (!current.reservation?.alreadyReady) {
    if (!current.artifact)
      throw new ReferenceLibraryError('source_unavailable');
    const bytes = await readArtifactBytes(
      storage,
      current.artifact.object,
      50 * 1024 * 1024,
    );
    current = await findOrReserve(bytes, current.artifact);
    if (!current.reservation) throw new Error('Reference reservation missing');
    if (!current.reservation.alreadyReady) {
      await storage.put(
        current.reservation.object,
        new Blob([new Uint8Array(bytes)]).stream(),
      );
      // Do not remove an immutable blob on an unknown commit response. A retry
      // reads this same request/version and can complete the pending reservation.
      await completeReferenceUpload(
        context,
        v.workspaceId,
        current.reservation.revisionId,
      );
    }
  }
  if (!current.reservation) throw new Error('Reference reservation missing');
  return {
    sourceId: current.reservation.sourceId,
    revisionId: current.reservation.revisionId,
  };
}

export async function changeReference(
  contextInput: RequestContext,
  sourceId: string,
  input: unknown,
) {
  const v = ReferenceActionSchema.parse(input),
    context = scoped(contextInput, v.workspaceId);
  return getDatabase().begin(async (tx) => {
    const { source, legacy } = await referenceSourceAccess(
      context,
      sourceId,
      tx,
      true,
      false,
      v.action === 'retry',
    );
    const [prior] =
      await tx`select input from allrice_knowledge_reference_actions where source_id=${source.id} and actor_id=${context.actor.id} and request_id=${v.requestId}`;
    if (prior) {
      if (!isDeepStrictEqual(prior.input, v))
        throw new ReferenceLibraryError('request_conflict');
      return { sourceId: source.id };
    }
    const [r] = await tx`select r.id,r.revision,o.media_type,o.size_bytes
      from allrice_knowledge_revisions r left join allrice_storage_objects o on o.id=r.file_object_id
      where r.knowledge_source_id=${source.id}
      and (${!legacy} or r.revision=${v.expectedRevision}) order by r.revision desc limit 1`;
    if (!r || r.revision !== v.expectedRevision)
      throw new ReferenceLibraryError('version_conflict');
    if (v.action === 'retry') {
      if (source.status !== 'active') throw new DataAccessError('not_found');
      if (legacy) await assertLegacyReferenceRevision(tx, r.id, legacy.id);
      const retryUnsupported =
        r.size_bytes !== null &&
        isIndexableKnowledgeTextSource({
          mediaType: r.media_type ?? '',
          sizeBytes: Number(r.size_bytes),
        });
      const rows =
        await tx`update allrice_knowledge_processing set state='saved',attempts=0,failure=null,updated_at=clock_timestamp()
        where revision_id=${r.id} and (state='failed' or (state='unsupported' and ${retryUnsupported})) returning revision_id`;
      if (!rows.length) {
        const [p] =
          await tx`select state from allrice_knowledge_processing where revision_id=${r.id}`;
        if (p?.state !== 'saved' && p?.state !== 'ready')
          throw new ReferenceLibraryError('processing_busy');
      }
    } else {
      await tx`update allrice_knowledge_sources set status=${v.action === 'archive' ? 'archived' : 'active'},updated_at=clock_timestamp() where id=${source.id}`;
    }
    await tx`insert into allrice_knowledge_reference_actions(source_id,actor_id,request_id,input) values(${source.id},${context.actor.id},${v.requestId},${tx.json(v)})`;
    await tx`insert into allrice_audit_events(organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id)
      values (${context.organizationId},${v.workspaceId},${context.actor.id},${'knowledge.reference.' + v.action},'knowledge_source',${source.id},'allowed','current_content_maintenance',${context.requestId})`;
    return { sourceId: source.id };
  });
}

export async function referenceLibraryOptions(
  contextInput: RequestContext,
  workspaceId: string,
) {
  const context = scoped(contextInput, workspaceId),
    principal = await readContentPrincipal(context);
  if (!principal) throw new DataAccessError('authorization_denied');
  const departments =
    await getDatabase()`select id,name from allrice_departments where organization_id=${context.organizationId} and archived_at is null
    and (${principal.maintenanceLevel === 'company'} or id=${principal.departmentId}) order by name,id`;
  return {
    workspaceId,
    platformMaintainer: await platformReferenceMaintainer(
      context,
      getDatabase(),
    ),
    maintenanceLevel: principal.maintenanceLevel,
    writable: principal.writable,
    departmentId: principal.departmentId,
    departments: Array.from(departments),
  };
}
