import { randomUUID } from 'node:crypto';

import {
  CreateMemoryInputSchema,
  CreateRagChunkInputSchema,
  ObjectKeySchema,
  StorageCategorySchema,
  UuidSchema,
  VectorRecallInputSchema,
  VisibilitySchema,
  authorize,
  makeObjectKey,
  type RequestContext,
  type SignedAccessGrant,
  type StorageObject,
  type Visibility,
} from '@allrice/contracts';
import { z } from 'zod';

import { getDatabase } from './core/client.ts';

const defaultWorkspaceQuotaBytes = 1024 * 1024 * 1024;

const CreateStorageMetadataSchema = z
  .object({
    id: UuidSchema,
    workspaceId: UuidSchema,
    category: StorageCategorySchema,
    mediaType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative(),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    visibility: VisibilitySchema,
    retentionUntil: z.string().datetime({ offset: true }).nullable(),
    immutable: z.boolean(),
  })
  .strict();

interface StorageObjectRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  object_key: string;
  category: string;
  media_type: string;
  size_bytes: number | string;
  checksum: string;
  visibility: Visibility;
  state: 'pending' | 'ready' | 'deleted';
  retention_until: Date | null;
  immutable: boolean;
  created_at: Date;
  deleted_at: Date | null;
}

export interface StoredFile {
  object: StorageObject;
  category: z.infer<typeof StorageCategorySchema>;
  visibility: Visibility;
  state: StorageObjectRow['state'];
  createdAt: string;
}

export class DataAccessError extends Error {
  constructor(
    public readonly code:
      | 'authentication_required'
      | 'authorization_denied'
      | 'not_found'
      | 'quota_exceeded'
      | 'grant_invalid',
  ) {
    super(code);
  }
}

function actorId(context: RequestContext) {
  if (context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  return context.actor.id;
}

function hasWorkspaceMembership(context: RequestContext, workspaceId: string) {
  return context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === actorId(context) &&
      membership.organizationId === context.organizationId &&
      (membership.workspaceId === null ||
        membership.workspaceId === workspaceId),
  );
}

function mapStoredFile(row: StorageObjectRow): StoredFile {
  const object: StorageObject = {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    key: ObjectKeySchema.parse(row.object_key),
    checksum: row.checksum as StorageObject['checksum'],
    mediaType: row.media_type,
    sizeBytes: Number(row.size_bytes),
    retentionUntil: row.retention_until?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    immutable: row.immutable,
  };
  return {
    object,
    category: StorageCategorySchema.parse(row.category),
    visibility: row.visibility,
    state: row.state,
    createdAt: row.created_at.toISOString(),
  };
}

function authorizeFile(
  context: RequestContext,
  row: StorageObjectRow,
  action: 'resource:read' | 'resource:delete',
) {
  const decision = authorize(
    {
      type: 'storage_object',
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      visibility: row.visibility,
      archivedAt: row.deleted_at?.toISOString() ?? null,
    },
    action,
    context,
  );
  if (!decision.allowed) throw new DataAccessError('authorization_denied');
}

async function audit(input: {
  context: RequestContext;
  workspaceId: string;
  action: string;
  resourceId: string;
  decision: 'allowed' | 'denied' | 'recorded';
  reason: string;
}) {
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id
    ) values (
      ${input.context.organizationId}, ${input.workspaceId},
      ${actorId(input.context)}, ${input.action}, 'storage_object',
      ${input.resourceId}, ${input.decision}, ${input.reason},
      ${input.context.requestId}
    )
  `;
}

export async function createStorageMetadata(
  context: RequestContext,
  input: unknown,
) {
  const metadata = CreateStorageMetadataSchema.parse(input);
  const owner = actorId(context);
  if (!hasWorkspaceMembership(context, metadata.workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  const key = makeObjectKey({
    organizationId: context.organizationId,
    workspaceId: metadata.workspaceId,
    ownerId: owner,
    category: metadata.category,
    objectId: metadata.id,
  });
  const sql = getDatabase();
  const row = await sql.begin(async (transaction) => {
    await transaction`
      select pg_advisory_xact_lock(
        hashtextextended(${`${context.organizationId}:${metadata.workspaceId}`}, 42)
      )
    `;
    const workspaces = await transaction<{ id: string }[]>`
      select id from allrice_workspaces
      where organization_id = ${context.organizationId}
        and id = ${metadata.workspaceId}
        and archived_at is null
    `;
    if (!workspaces[0]) throw new DataAccessError('authorization_denied');
    const quotas = await transaction<
      { limit_bytes: number | string; used_bytes: number | string }[]
    >`
      select
        coalesce(q.limit_bytes, ${defaultWorkspaceQuotaBytes}) as limit_bytes,
        coalesce(sum(o.size_bytes) filter (where o.state <> 'deleted'), 0) as used_bytes
      from allrice_workspaces w
      left join allrice_storage_quotas q
        on q.organization_id = w.organization_id and q.workspace_id = w.id
      left join allrice_storage_objects o
        on o.organization_id = w.organization_id and o.workspace_id = w.id
      where w.organization_id = ${context.organizationId}
        and w.id = ${metadata.workspaceId}
      group by q.limit_bytes
    `;
    const quota = quotas[0];
    if (
      !quota ||
      Number(quota.used_bytes) + metadata.sizeBytes > Number(quota.limit_bytes)
    ) {
      throw new DataAccessError('quota_exceeded');
    }
    const rows = await transaction<StorageObjectRow[]>`
      insert into allrice_storage_objects (
        id, organization_id, workspace_id, owner_id, object_key, category,
        media_type, size_bytes, checksum, visibility, retention_until, immutable
      ) values (
        ${metadata.id}, ${context.organizationId}, ${metadata.workspaceId},
        ${owner}, ${key}, ${metadata.category}, ${metadata.mediaType},
        ${metadata.sizeBytes}, ${metadata.checksum}, ${metadata.visibility},
        ${metadata.retentionUntil}, ${metadata.immutable}
      )
      returning *
    `;
    return rows[0];
  });
  if (!row) throw new Error('storage metadata creation failed');
  await audit({
    context,
    workspaceId: metadata.workspaceId,
    action: 'storage.create',
    resourceId: metadata.id,
    decision: 'allowed',
    reason: 'owner_with_workspace_membership',
  });
  return mapStoredFile(row);
}

export async function markStorageReady(
  context: RequestContext,
  objectId: string,
) {
  const sql = getDatabase();
  const rows = await sql<StorageObjectRow[]>`
    update allrice_storage_objects
    set state = 'ready', updated_at = now()
    where id = ${UuidSchema.parse(objectId)}
      and organization_id = ${context.organizationId}
      and owner_id = ${actorId(context)}
      and state = 'pending'
    returning *
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  return mapStoredFile(row);
}

export async function abandonStorageMetadata(
  context: RequestContext,
  objectId: string,
) {
  const sql = getDatabase();
  await sql`
    update allrice_storage_objects
    set state = 'deleted', deleted_at = now(), updated_at = now()
    where id = ${UuidSchema.parse(objectId)}
      and organization_id = ${context.organizationId}
      and owner_id = ${actorId(context)}
      and state = 'pending'
  `;
}

export async function getStoredFile(context: RequestContext, objectId: string) {
  const sql = getDatabase();
  const rows = await sql<StorageObjectRow[]>`
    select * from allrice_storage_objects
    where id = ${UuidSchema.parse(objectId)}
      and organization_id = ${context.organizationId}
      and (${context.workspaceId}::uuid is null or workspace_id = ${context.workspaceId})
      and state = 'ready'
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  try {
    authorizeFile(context, row, 'resource:read');
  } catch (error) {
    await audit({
      context,
      workspaceId: row.workspace_id,
      action: 'storage.read',
      resourceId: row.id,
      decision: 'denied',
      reason: 'resource_policy_denied',
    });
    throw error;
  }
  return mapStoredFile(row);
}

export async function prepareStorageDelete(
  context: RequestContext,
  objectId: string,
) {
  const sql = getDatabase();
  const rows = await sql<StorageObjectRow[]>`
    select * from allrice_storage_objects
    where id = ${UuidSchema.parse(objectId)}
      and organization_id = ${context.organizationId}
      and (${context.workspaceId}::uuid is null or workspace_id = ${context.workspaceId})
      and state = 'ready'
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  authorizeFile(context, row, 'resource:delete');
  return mapStoredFile(row);
}

export async function completeStorageDelete(
  context: RequestContext,
  objectId: string,
) {
  const sql = getDatabase();
  const rows = await sql<StorageObjectRow[]>`
    update allrice_storage_objects
    set state = 'deleted', deleted_at = now(), updated_at = now()
    where id = ${UuidSchema.parse(objectId)}
      and organization_id = ${context.organizationId}
      and state = 'ready'
    returning *
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  await sql`
    update allrice_storage_access_grants
    set revoked_at = now()
    where object_id = ${row.id} and revoked_at is null
  `;
  await sql.begin(async (transaction) => {
    const memories = await transaction<{ id: string }[]>`
      update allrice_memories
      set archived_at = now(), updated_at = now()
      where organization_id = ${context.organizationId}
        and workspace_id = ${row.workspace_id}
        and source_type = 'file'
        and source_id = ${row.id}
        and archived_at is null
      returning id
    `;
    if (memories.length > 0) {
      await transaction`
        delete from allrice_rag_chunks
        where organization_id = ${context.organizationId}
          and workspace_id = ${row.workspace_id}
          and memory_id in ${transaction(memories.map((memory) => memory.id))}
      `;
    }
  });
  await audit({
    context,
    workspaceId: row.workspace_id,
    action: 'storage.delete',
    resourceId: row.id,
    decision: 'allowed',
    reason: 'resource_policy_allowed',
  });
}

export async function saveStorageGrant(
  context: RequestContext,
  grant: SignedAccessGrant,
) {
  if (grant.subjectId !== actorId(context)) {
    throw new DataAccessError('authorization_denied');
  }
  const file = await getStoredFile(context, grant.objectId);
  const sql = getDatabase();
  await sql`
    insert into allrice_storage_access_grants (
      nonce, object_id, subject_id, operation, expires_at
    ) values (
      ${grant.nonce}, ${grant.objectId}, ${grant.subjectId},
      ${grant.operation}, ${grant.expiresAt}
    )
  `;
  await audit({
    context,
    workspaceId: file.object.workspaceId,
    action: 'storage.sign',
    resourceId: file.object.id,
    decision: 'allowed',
    reason: 'resource_policy_allowed',
  });
}

export async function resolveStorageGrant(grant: SignedAccessGrant) {
  const sql = getDatabase();
  const rows = await sql<StorageObjectRow[]>`
    select o.*
    from allrice_storage_access_grants g
    join allrice_storage_objects o on o.id = g.object_id
    where g.nonce = ${grant.nonce}
      and g.object_id = ${grant.objectId}
      and g.subject_id = ${grant.subjectId}
      and g.operation = ${grant.operation}
      and g.expires_at > now()
      and g.revoked_at is null
      and o.state = 'ready'
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('grant_invalid');
  return mapStoredFile(row);
}

export async function createMemory(context: RequestContext, input: unknown) {
  const memory = CreateMemoryInputSchema.parse(input);
  const owner = actorId(context);
  if (!hasWorkspaceMembership(context, memory.workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const rows = await sql<{ id: string }[]>`
    insert into allrice_memories (
      organization_id, workspace_id, project_id, employee_id, owner_id,
      content, metadata, visibility, source_type, source_id
    ) values (
      ${context.organizationId}, ${memory.workspaceId}, ${memory.projectId},
      ${memory.employeeId},
      ${owner}, ${memory.content}, ${sql.json(memory.metadata)},
      ${memory.visibility}, ${memory.sourceType}, ${memory.sourceId}
    )
    returning id
  `;
  if (!rows[0]) throw new Error('memory creation failed');
  return { id: rows[0].id };
}

export async function createRagChunk(context: RequestContext, input: unknown) {
  const chunk = CreateRagChunkInputSchema.parse(input);
  const owner = actorId(context);
  if (!hasWorkspaceMembership(context, chunk.workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  const sql = getDatabase();
  const memories = await sql<
    { id: string; owner_id: string; visibility: Visibility }[]
  >`
    select id, owner_id, visibility from allrice_memories
    where id = ${chunk.memoryId}
      and organization_id = ${context.organizationId}
      and workspace_id = ${chunk.workspaceId}
      and archived_at is null
  `;
  const memory = memories[0];
  if (!memory || memory.owner_id !== owner) {
    throw new DataAccessError('authorization_denied');
  }
  const rows = await sql<{ id: string }[]>`
    insert into allrice_rag_chunks (
      organization_id, workspace_id, memory_id, owner_id,
      content, embedding, visibility
    ) values (
      ${context.organizationId}, ${chunk.workspaceId}, ${chunk.memoryId},
      ${owner}, ${chunk.content}, ${vectorLiteral(chunk.embedding)}::vector,
      ${memory.visibility}
    )
    returning id
  `;
  if (!rows[0]) throw new Error('RAG chunk creation failed');
  return { id: rows[0].id };
}

function vectorLiteral(values: number[]) {
  return `[${values.join(',')}]`;
}

export async function recallRagChunks(context: RequestContext, input: unknown) {
  const query = VectorRecallInputSchema.parse(input);
  const owner = actorId(context);
  if (!hasWorkspaceMembership(context, query.workspaceId)) {
    throw new DataAccessError('authorization_denied');
  }
  const embedding = vectorLiteral(query.embedding);
  const sql = getDatabase();
  return sql<
    {
      id: string;
      memory_id: string;
      content: string;
      owner_id: string;
      similarity: number;
    }[]
  >`
    select id, memory_id, content, owner_id,
           1 - (embedding <=> ${embedding}::vector) as similarity
    from allrice_rag_chunks
    where organization_id = ${context.organizationId}
      and workspace_id = ${query.workspaceId}
      and (owner_id = ${owner} or visibility <> 'private')
    order by embedding <=> ${embedding}::vector
    limit ${query.limit}
  `;
}

export function newStorageObjectId() {
  return randomUUID();
}
