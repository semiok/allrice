import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import {
  ContentOwnershipSchema,
  ReferenceActionSchema,
  ReferenceRevisionSchema,
  ReferenceUploadInputSchema,
  UuidSchema,
  MembershipSchema,
  type ContentOwnership,
  type ReferenceRevision,
  type RequestContext,
  type StorageObject,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { isPlatformAdmin } from './providers/model-pool.ts';
import { lockWorkspaceStorageQuota } from './core/storage-quota.ts';
import { createStorageMetadata, DataAccessError } from './data.ts';
import {
  getContentAccess,
  readContentPrincipal,
  type ContentIdentity,
} from './content-maintenance.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
export class ReferenceLibraryError extends Error {
  constructor(
    public readonly code:
      | 'version_conflict'
      | 'request_conflict'
      | 'invalid_content'
      | 'processing_busy',
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
) {
  const access = await getContentAccess(context, ownership, sql, maintain);
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
) {
  if (maintain) await readContentPrincipal(context, sql, true);
  const [s] = await sql<
    SourceRow[]
  >`select id,organization_id,workspace_id,ownership,status
    from allrice_knowledge_sources where id=${UuidSchema.parse(sourceId)} and ownership is not null
    ${maintain ? sql`for update` : sql``}`;
  if (!s) throw new DataAccessError('not_found');
  const ownership = ContentOwnershipSchema.parse(s.ownership);
  const access = await referenceAccess(context, ownership, sql, maintain);
  if (!access.canRead || (maintain && !access.canMaintain))
    throw new DataAccessError('not_found');
  return { source: s, ownership, access };
}

export async function listReferenceRevisions(
  contextInput: RequestContext,
  workspaceId: string,
  sourceId?: string,
): Promise<ReferenceRevision[]> {
  const context = scoped(contextInput, workspaceId),
    sql = getDatabase();
  if (!(await readContentPrincipal(context)))
    throw new DataAccessError('authorization_denied');
  const sources = await sql<
    SourceRow[]
  >`select id,organization_id,workspace_id,ownership,status from allrice_knowledge_sources
    where ownership is not null and (organization_id=${context.organizationId} or ownership->>'scope'='platform')
    and (${sourceId ?? null}::uuid is null or id=${sourceId ?? null}) order by updated_at desc,id`;
  const result: ReferenceRevision[] = [];
  for (const s of sources) {
    const ownership = ContentOwnershipSchema.parse(s.ownership),
      access = await referenceAccess(context, ownership, sql);
    if (!access.canRead || (s.status === 'archived' && !access.canMaintain))
      continue;
    const rows =
      await sql`select r.id,r.revision,r.file_name,r.description,r.created_at,o.checksum,o.size_bytes,o.media_type,
      p.state,p.failure,o.state as file_state from allrice_knowledge_revisions r join allrice_storage_objects o on o.id=r.file_object_id
      join allrice_knowledge_processing p on p.revision_id=r.id where r.knowledge_source_id=${s.id} and r.status='published'
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
          sizeBytes: Number(r.size_bytes),
          mediaType: r.media_type,
          status: s.status,
          processing: r.file_state === 'pending' ? 'uploading' : r.state,
          failure: r.failure,
          canMaintain: access.canMaintain,
          createdAt: r.created_at.toISOString(),
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
) {
  const context = scoped(contextInput, workspaceId);
  const [r] = await sql<
    { knowledge_source_id: string; file_name: string; file_object_id: string }[]
  >`select knowledge_source_id,file_name,file_object_id
    from allrice_knowledge_revisions where id=${UuidSchema.parse(revisionId)} and file_object_id is not null and status='published'`;
  if (!r) throw new DataAccessError('not_found');
  const { source } = await referenceSourceAccess(
    context,
    r.knowledge_source_id,
    sql,
  );
  if (source.status !== 'active') throw new DataAccessError('not_found');
  const [o] = await sql<
    FileRow[]
  >`select * from allrice_storage_objects where id=${r.file_object_id} and state='ready' and deleted_at is null`;
  if (!o) throw new DataAccessError('not_found');
  return { object: object(o), fileName: r.file_name, sourceId: source.id };
}

export async function prepareReferenceUpload(
  contextInput: RequestContext,
  input: unknown,
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
  const ownership: ContentOwnership =
    v.scope === 'platform'
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
  const requestInput = { ...metadata, checksum, sizeBytes: bytes.length };
  const result = await getDatabase().begin(async (tx) => {
    await lockWorkspaceStorageQuota(tx, context.organizationId, v.workspaceId);
    if (!(await referenceAccess(context, ownership, tx, true)).canMaintain)
      throw new DataAccessError('authorization_denied');
    await tx`select pg_advisory_xact_lock(hashtextextended(${context.organizationId + ':reference:' + context.actor.id + ':' + v.requestId},0))`;
    const [prior] =
      await tx`select id,knowledge_source_id,request_input,file_object_id from allrice_knowledge_revisions
      where organization_id=${context.organizationId} and created_by=${context.actor.id} and request_id=${v.requestId}`;
    if (prior) {
      if (!isDeepStrictEqual(prior.request_input, requestInput))
        throw new ReferenceLibraryError('request_conflict');
      const { source } = await referenceSourceAccess(
        context,
        prior.knowledge_source_id,
        tx,
        true,
      );
      if (source.status !== 'active') throw new DataAccessError('not_found');
      const [file] = await tx<
        FileRow[]
      >`select * from allrice_storage_objects where id=${prior.file_object_id}`;
      if (!file || file.state === 'deleted')
        throw new ReferenceLibraryError('invalid_content');
      return {
        revisionId: prior.id as string,
        sourceId: prior.knowledge_source_id as string,
        object: object(file),
        alreadyReady: file.state === 'ready',
      };
    }
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
        sizeBytes: bytes.length,
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
      await tx`insert into allrice_knowledge_revisions (organization_id,workspace_id,knowledge_source_id,revision,name,description,status,definition,checksum,created_by,file_object_id,file_name,request_id,request_input)
      values (${source.organization_id},${source.workspace_id},${source.id},${revision},${v.fileName},${v.purpose || '参考资料'},'draft',${tx.json(definition)},${digest},${context.actor.id},${file.object.id},${v.fileName},${v.requestId},${tx.json(requestInput)}) returning id`;
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
  });
  return { ...result, bytes };
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
      await tx`select knowledge_source_id,file_object_id,created_by from allrice_knowledge_revisions where id=${UuidSchema.parse(revisionId)}`;
    if (!r || r.created_by !== c.actor.id)
      throw new DataAccessError('not_found');
    const { source } = await referenceSourceAccess(
      c,
      r.knowledge_source_id,
      tx,
      true,
    );
    if (source.status !== 'active') throw new DataAccessError('not_found');
    await tx`update allrice_storage_objects set state='ready',updated_at=clock_timestamp() where id=${r.file_object_id} and state='pending'`;
  });
}

export async function changeReference(
  contextInput: RequestContext,
  sourceId: string,
  input: unknown,
) {
  const v = ReferenceActionSchema.parse(input),
    context = scoped(contextInput, v.workspaceId);
  return getDatabase().begin(async (tx) => {
    const { source } = await referenceSourceAccess(context, sourceId, tx, true);
    const [prior] =
      await tx`select input from allrice_knowledge_reference_actions where source_id=${source.id} and actor_id=${context.actor.id} and request_id=${v.requestId}`;
    if (prior) {
      if (!isDeepStrictEqual(prior.input, v))
        throw new ReferenceLibraryError('request_conflict');
      return { sourceId: source.id };
    }
    const [r] =
      await tx`select id,revision from allrice_knowledge_revisions where knowledge_source_id=${source.id} order by revision desc limit 1`;
    if (!r || r.revision !== v.expectedRevision)
      throw new ReferenceLibraryError('version_conflict');
    if (v.action === 'retry') {
      if (source.status !== 'active') throw new DataAccessError('not_found');
      const rows =
        await tx`update allrice_knowledge_processing set state='saved',attempts=0,failure=null,updated_at=clock_timestamp()
        where revision_id=${r.id} and state='failed' returning revision_id`;
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
