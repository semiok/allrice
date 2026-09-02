import { createHash } from 'node:crypto';

import {
  KnowledgeIndexDocumentSchema,
  KnowledgeRetrievalResultSchema,
  UuidSchema,
  type ExecutionContext,
  type KnowledgeIndexDocument,
  type KnowledgeRetrievalResult,
  type StorageObject,
  type Visibility,
} from '@allrice/contracts';

import { getDatabase } from '../core/client.ts';

const readableMediaTypes = ['text/plain', 'text/markdown', 'application/json'];

function vectorLiteral(values: number[]) {
  return `[${values.join(',')}]`;
}

export function embedKnowledgeText(text: string) {
  const dimensions = 1536;
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [text];
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    for (let offset = 0; offset < 24; offset += 4) {
      const value = digest.readUInt32BE(offset);
      const index = value % dimensions;
      vector[index] = (vector[index] ?? 0) + (value & 1 ? 1 : -1);
    }
  }
  const magnitude = Math.sqrt(
    vector.reduce((sum, value) => sum + value * value, 0),
  );
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function actorId(context: ExecutionContext) {
  return context.policySnapshot.subjectId;
}

export interface KnowledgeSourceFile {
  knowledgeRevisionId: string;
  sourceRef: string;
  title: string;
  updatedAt: string;
  needsIndex: boolean;
  object: StorageObject;
  visibility: Visibility;
}

export async function listKnowledgeSourceFilesForExecution(input: {
  context: ExecutionContext;
  employeeId: string;
  knowledgeRevisionIds: string[];
}): Promise<KnowledgeSourceFile[]> {
  if (!input.context.workspaceId || input.knowledgeRevisionIds.length === 0) {
    return [];
  }
  const revisionIds = [...new Set(input.knowledgeRevisionIds)].map((id) =>
    UuidSchema.parse(id),
  );
  const sql = getDatabase();
  const rows = await sql<
    {
      knowledge_revision_id: string;
      resource_ref: string;
      id: string;
      organization_id: string;
      workspace_id: string;
      owner_id: string;
      object_key: string;
      checksum: string;
      media_type: string;
      size_bytes: number | string;
      visibility: Visibility;
      retention_until: Date | null;
      deleted_at: Date | null;
      immutable: boolean;
      file_name: string;
      updated_at: Date;
      indexed_checksum: string | null;
      indexed_visibility: Visibility | null;
      indexed_owner_id: string | null;
    }[]
  >`
    select r.id as knowledge_revision_id,
      r.definition->>'resourceRef' as resource_ref,
      o.id, o.organization_id, o.workspace_id, o.owner_id, o.object_key,
      o.checksum, o.media_type, o.size_bytes, o.visibility,
      o.retention_until, o.deleted_at, o.immutable,
      coalesce(max(f.file_name), '未命名文件') as file_name,
      o.updated_at, max(d.checksum) as indexed_checksum,
      max(d.visibility) as indexed_visibility,
      max(d.owner_id::text) as indexed_owner_id
    from allrice_knowledge_revisions r
    join allrice_knowledge_sources s on s.id = r.knowledge_source_id
    join allrice_employee_knowledge_bindings b
      on b.knowledge_revision_id = r.id
     and b.organization_id = r.organization_id
     and b.workspace_id = r.workspace_id
     and b.employee_id = ${UuidSchema.parse(input.employeeId)} and b.enabled
    join allrice_storage_objects o
      on o.organization_id = r.organization_id
     and o.workspace_id = r.workspace_id
     and o.category = 'uploads' and o.state = 'ready'
     and (
       r.definition->>'resourceRef' = 'workspace' or
       replace(r.definition->>'resourceRef', 'file:', '') = o.id::text
     )
    left join allrice_file_references f on f.object_id = o.id
    left join allrice_knowledge_documents d
      on d.knowledge_revision_id = r.id
     and d.source_ref = concat('file:', o.id::text) and d.active
    where r.organization_id = ${input.context.organizationId}
      and r.workspace_id = ${input.context.workspaceId}
      and r.id in ${sql(revisionIds)}
      and r.status = 'published' and s.status = 'active'
      and r.definition->>'sourceKind' = 'workspace_files'
      and o.media_type in ${sql(readableMediaTypes)}
      and (o.owner_id = ${actorId(input.context)} or o.visibility <> 'private')
      and exists (
        select 1 from allrice_knowledge_acl_entries a
        where a.knowledge_revision_id = r.id
          and a.permission in ('read', 'admin')
          and (
            (a.principal_type = 'organization' and a.principal_id = ${input.context.organizationId}) or
            (a.principal_type = 'workspace' and a.principal_id = ${input.context.workspaceId}) or
            (a.principal_type = 'employee' and a.principal_id = ${input.employeeId}) or
            (a.principal_type = 'user' and a.principal_id = ${actorId(input.context)})
          )
      )
    group by r.id, o.id
    order by o.updated_at desc, o.id
  `;
  return rows.map((row) => ({
    knowledgeRevisionId: row.knowledge_revision_id,
    sourceRef: `file:${row.id}`,
    title: row.file_name,
    updatedAt: row.updated_at.toISOString(),
    needsIndex:
      row.indexed_checksum !== row.checksum ||
      row.indexed_visibility !== row.visibility ||
      row.indexed_owner_id !== row.owner_id,
    visibility: row.visibility,
    object: {
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      key: row.object_key,
      checksum: row.checksum as StorageObject['checksum'],
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      retentionUntil: row.retention_until?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      immutable: row.immutable,
    },
  }));
}

export async function indexKnowledgeDocumentForExecution(input: {
  context: ExecutionContext;
  employeeId: string;
  document: KnowledgeIndexDocument;
}) {
  if (!input.context.workspaceId) throw new Error('workspace is required');
  const document = KnowledgeIndexDocumentSchema.parse(input.document);
  const sql = getDatabase();
  await sql.begin(async (transaction) => {
    const authorized = await transaction<{ id: string }[]>`
      select r.id
      from allrice_knowledge_revisions r
      join allrice_knowledge_sources s on s.id = r.knowledge_source_id
      join allrice_employee_knowledge_bindings b
        on b.knowledge_revision_id = r.id and b.employee_id = ${input.employeeId}
       and b.organization_id = r.organization_id
       and b.workspace_id = r.workspace_id and b.enabled
      where r.id = ${document.knowledgeRevisionId}
        and r.organization_id = ${input.context.organizationId}
        and r.workspace_id = ${input.context.workspaceId}
        and r.status = 'published' and s.status = 'active'
        and exists (
          select 1 from allrice_knowledge_acl_entries a
          where a.knowledge_revision_id = r.id
            and a.permission in ('read', 'admin')
            and (
              (a.principal_type = 'organization' and a.principal_id = ${input.context.organizationId}) or
              (a.principal_type = 'workspace' and a.principal_id = ${input.context.workspaceId}) or
              (a.principal_type = 'employee' and a.principal_id = ${input.employeeId}) or
              (a.principal_type = 'user' and a.principal_id = ${actorId(input.context)})
            )
        )
    `;
    if (!authorized[0]) throw new Error('knowledge indexing is not authorized');
    if (document.storageObjectId) {
      const objects = await transaction<{ id: string }[]>`
        select id from allrice_storage_objects
        where id = ${document.storageObjectId}
          and organization_id = ${input.context.organizationId}
          and workspace_id = ${input.context.workspaceId}
          and owner_id = ${document.ownerId}
          and visibility = ${document.visibility}
          and checksum = ${document.checksum} and state = 'ready'
          and (owner_id = ${actorId(input.context)} or visibility <> 'private')
      `;
      if (!objects[0])
        throw new Error('knowledge source object is not authorized');
    }
    const rows = await transaction<{ id: string; checksum: string }[]>`
      insert into allrice_knowledge_documents (
        organization_id, workspace_id, knowledge_revision_id, source_ref,
        storage_object_id, owner_id, visibility, title, media_type, checksum,
        source_updated_at, indexed_at, active
      ) values (
        ${input.context.organizationId}, ${input.context.workspaceId},
        ${document.knowledgeRevisionId}, ${document.sourceRef},
        ${document.storageObjectId}, ${document.ownerId}, ${document.visibility},
        ${document.title}, ${document.mediaType}, ${document.checksum},
        ${new Date(document.updatedAt)}, now(), true
      ) on conflict (knowledge_revision_id, source_ref) do update set
        storage_object_id = excluded.storage_object_id,
        owner_id = excluded.owner_id, visibility = excluded.visibility,
        title = excluded.title, media_type = excluded.media_type,
        checksum = excluded.checksum,
        source_updated_at = excluded.source_updated_at,
        indexed_at = now(), active = true
      returning id, checksum
    `;
    const stored = rows[0];
    if (!stored) throw new Error('knowledge document indexing failed');
    await transaction`
      delete from allrice_knowledge_chunks where document_id = ${stored.id}
    `;
    for (const [ordinal, chunk] of document.chunks.entries()) {
      const embedding = vectorLiteral(embedKnowledgeText(chunk.content));
      await transaction`
        insert into allrice_knowledge_chunks (
          organization_id, workspace_id, document_id, ordinal, content,
          embedding, locator, token_count, owner_id, visibility
        ) values (
          ${input.context.organizationId}, ${input.context.workspaceId},
          ${stored.id}, ${ordinal}, ${chunk.content}, ${embedding}::vector,
          ${transaction.json({
            sourceRef: document.sourceRef,
            chunk: ordinal,
            start: chunk.start,
            end: chunk.end,
          })}, ${Math.max(1, Math.ceil(chunk.content.length / 4))},
          ${document.ownerId}, ${document.visibility}
        )
      `;
    }
    await transaction`
      insert into allrice_audit_events (
        organization_id, workspace_id, actor_id, action, resource_type,
        resource_id, decision, reason, metadata
      ) values (
        ${input.context.organizationId}, ${input.context.workspaceId},
        ${actorId(input.context)}, 'knowledge.index', 'knowledge_document',
        ${stored.id}, 'allowed', 'frozen_snapshot_acl_allowed',
        ${transaction.json({
          runId: input.context.runId,
          knowledgeRevisionId: document.knowledgeRevisionId,
          sourceRef: document.sourceRef,
          checksum: document.checksum,
          chunkCount: document.chunks.length,
        })}
      )
    `;
  });
}

export async function retrieveKnowledgeForExecution(input: {
  context: ExecutionContext;
  employeeId: string;
  knowledgeRevisionIds: string[];
  query: string;
  limit?: number;
}): Promise<KnowledgeRetrievalResult[]> {
  if (!input.context.workspaceId || input.knowledgeRevisionIds.length === 0) {
    return [];
  }
  const revisionIds = [...new Set(input.knowledgeRevisionIds)].map((id) =>
    UuidSchema.parse(id),
  );
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 12);
  const embedding = vectorLiteral(embedKnowledgeText(input.query));
  const pattern = `%${input.query.trim().slice(0, 500)}%`;
  const sql = getDatabase();
  const rows = await sql<
    {
      chunk_id: string;
      content: string;
      document_id: string;
      knowledge_revision_id: string;
      source_kind: 'workspace_files' | 'connector' | 'managed';
      source_ref: string;
      title: string;
      locator: unknown;
      source_updated_at: Date;
      principal_type: 'organization' | 'workspace' | 'employee' | 'user';
      score: number;
    }[]
  >`
    select c.id as chunk_id, c.content, d.id as document_id,
      d.knowledge_revision_id,
      (r.definition->>'sourceKind')::text as source_kind,
      d.source_ref, d.title, c.locator, d.source_updated_at,
      acl.principal_type,
      greatest(-1, least(1,
        (0.8 * (1 - (c.embedding <=> ${embedding}::vector))) +
        (0.2 * case when c.content ilike ${pattern} then 1 else 0 end)
      ))::float8 as score
    from allrice_knowledge_chunks c
    join allrice_knowledge_documents d on d.id = c.document_id and d.active
    left join allrice_storage_objects o on o.id = d.storage_object_id
    join allrice_knowledge_revisions r
      on r.id = d.knowledge_revision_id and r.status = 'published'
    join allrice_knowledge_sources s
      on s.id = r.knowledge_source_id and s.status = 'active'
    join allrice_employee_knowledge_bindings b
      on b.knowledge_revision_id = r.id and b.employee_id = ${input.employeeId}
     and b.organization_id = r.organization_id
     and b.workspace_id = r.workspace_id and b.enabled
    join lateral (
      select a.principal_type
      from allrice_knowledge_acl_entries a
      where a.knowledge_revision_id = r.id
        and a.permission in ('read', 'admin')
        and (
          (a.principal_type = 'organization' and a.principal_id = ${input.context.organizationId}) or
          (a.principal_type = 'workspace' and a.principal_id = ${input.context.workspaceId}) or
          (a.principal_type = 'employee' and a.principal_id = ${input.employeeId}) or
          (a.principal_type = 'user' and a.principal_id = ${actorId(input.context)})
        )
      order by case a.principal_type
        when 'user' then 1 when 'employee' then 2
        when 'workspace' then 3 else 4 end
      limit 1
    ) acl on true
    where c.organization_id = ${input.context.organizationId}
      and c.workspace_id = ${input.context.workspaceId}
      and d.knowledge_revision_id in ${sql(revisionIds)}
      and (c.owner_id = ${actorId(input.context)} or c.visibility <> 'private')
      and (
        d.storage_object_id is null or (
          o.state = 'ready' and
          (o.owner_id = ${actorId(input.context)} or o.visibility <> 'private')
        )
      )
    order by score desc, d.source_updated_at desc, c.id
    limit ${limit}
  `;
  return rows.map((row) =>
    KnowledgeRetrievalResultSchema.parse({
      content: row.content,
      citation: {
        type: 'knowledge',
        id: row.chunk_id,
        label: `${row.title} · 片段 ${
          typeof row.locator === 'object' &&
          row.locator !== null &&
          'chunk' in row.locator &&
          typeof row.locator.chunk === 'number'
            ? row.locator.chunk + 1
            : 1
        }`,
        knowledgeRevisionId: row.knowledge_revision_id,
        documentId: row.document_id,
        sourceKind: row.source_kind,
        scope: row.principal_type,
        locator: row.locator,
        updatedAt: row.source_updated_at.toISOString(),
        score: Number(row.score),
      },
    }),
  );
}
