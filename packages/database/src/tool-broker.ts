import {
  ObjectKeySchema,
  UuidSchema,
  authorizeExecution,
  type ExecutionContext,
  type StorageObject,
  type Visibility,
} from '@allrice/contracts';

import { DataAccessError } from './data.ts';
import { getDatabase } from './index.ts';

interface ResourceRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  owner_id: string;
  visibility: Visibility;
}

function authorizeRead(
  context: ExecutionContext,
  type: 'storage_object' | 'memory' | 'chat_session',
  row: ResourceRow,
) {
  const decision = authorizeExecution(
    {
      type,
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      visibility: row.visibility,
      archivedAt: null,
    },
    'resource:read',
    context,
  );
  if (!decision.allowed) throw new DataAccessError('authorization_denied');
}

export async function recordToolBrokerAudit(input: {
  context: ExecutionContext;
  toolName: string;
  resourceId?: string;
  decision?: 'allowed' | 'denied';
  reason?: string;
}) {
  const sql = getDatabase();
  await sql`
    insert into allrice_audit_events (
      organization_id, workspace_id, actor_id, action, resource_type,
      resource_id, decision, reason, request_id, metadata
    ) values (
      ${input.context.organizationId}, ${input.context.workspaceId},
      ${input.context.policySnapshot.subjectId}, 'tool.execute', 'tool_broker',
      ${input.resourceId ?? null}, ${input.decision ?? 'allowed'},
      ${input.reason ?? 'frozen_policy_authorized'}, null,
      ${sql.json({
        executionId: input.context.executionId,
        runId: input.context.runId,
        toolName: input.toolName,
      })}
    )
  `;
}

export async function listToolBrokerFiles(
  context: ExecutionContext,
  limit: number,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const rows = await sql<
    (ResourceRow & {
      file_name: string;
      media_type: string;
      size_bytes: number | string;
      created_at: Date;
    })[]
  >`
    select o.id, o.organization_id, o.workspace_id, o.owner_id, o.visibility,
      coalesce(max(f.file_name), '未命名文件') as file_name,
      o.media_type, o.size_bytes, o.created_at
    from allrice_storage_objects o
    left join allrice_file_references f on f.object_id = o.id
    where o.organization_id = ${context.organizationId}
      and o.workspace_id = ${context.workspaceId}
      and o.category = 'uploads' and o.state = 'ready'
      and (o.owner_id = ${context.policySnapshot.subjectId}
        or o.visibility <> 'private')
    group by o.id
    order by o.created_at desc
    limit ${Math.min(Math.max(limit, 1), 50)}
  `;
  return rows.map((row) => {
    authorizeRead(context, 'storage_object', row);
    return {
      id: row.id,
      fileName: row.file_name,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      visibility: row.visibility,
      createdAt: row.created_at.toISOString(),
    };
  });
}

export async function getToolBrokerFile(
  context: ExecutionContext,
  objectIdInput: string,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const rows = await sql<
    (ResourceRow & {
      file_name: string;
      object_key: string;
      checksum: string;
      media_type: string;
      size_bytes: number | string;
      retention_until: Date | null;
      deleted_at: Date | null;
      immutable: boolean;
    })[]
  >`
    select o.id, o.organization_id, o.workspace_id, o.owner_id, o.visibility,
      coalesce(max(f.file_name), '未命名文件') as file_name,
      o.object_key, o.checksum, o.media_type, o.size_bytes,
      o.retention_until, o.deleted_at, o.immutable
    from allrice_storage_objects o
    left join allrice_file_references f on f.object_id = o.id
    where o.id = ${UuidSchema.parse(objectIdInput)}
      and o.organization_id = ${context.organizationId}
      and o.workspace_id = ${context.workspaceId} and o.state = 'ready'
    group by o.id
  `;
  const row = rows[0];
  if (!row) throw new DataAccessError('not_found');
  authorizeRead(context, 'storage_object', row);
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
  return { object, fileName: row.file_name, visibility: row.visibility };
}

export async function searchToolBrokerMemories(
  context: ExecutionContext,
  query: string,
  limit: number,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const pattern = `%${query.trim().slice(0, 500)}%`;
  const rows = await sql<
    (ResourceRow & { content: string; updated_at: Date })[]
  >`
    select id, organization_id, workspace_id, owner_id, visibility,
      content, updated_at
    from allrice_memories
    where organization_id = ${context.organizationId}
      and workspace_id = ${context.workspaceId} and archived_at is null
      and (owner_id = ${context.policySnapshot.subjectId}
        or visibility <> 'private')
      and content ilike ${pattern}
    order by updated_at desc
    limit ${Math.min(Math.max(limit, 1), 20)}
  `;
  return rows.map((row) => {
    authorizeRead(context, 'memory', row);
    return {
      id: row.id,
      content: row.content.slice(0, 4_000),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export async function searchToolBrokerSessions(
  context: ExecutionContext,
  query: string,
  limit: number,
) {
  if (!context.workspaceId) throw new DataAccessError('authorization_denied');
  const sql = getDatabase();
  const pattern = `%${query.trim().slice(0, 500)}%`;
  const rows = await sql<(ResourceRow & { title: string; updated_at: Date })[]>`
    select id, organization_id, workspace_id, owner_id, visibility,
      title, updated_at
    from allrice_chat_sessions
    where organization_id = ${context.organizationId}
      and workspace_id = ${context.workspaceId} and archived_at is null
      and (owner_id = ${context.policySnapshot.subjectId}
        or visibility <> 'private')
      and title ilike ${pattern}
    order by updated_at desc
    limit ${Math.min(Math.max(limit, 1), 20)}
  `;
  return rows.map((row) => {
    authorizeRead(context, 'chat_session', row);
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at.toISOString(),
    };
  });
}
