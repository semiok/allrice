import { randomUUID } from 'node:crypto';
import {
  ContentOwnershipSchema,
  KnowledgeIndexDocumentSchema,
  type StorageObject,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { writeKnowledgeDocument } from './memory/knowledge-retrieval.ts';

export async function claimReferenceProcessing() {
  return getDatabase().begin(async (tx) => {
    await tx`update allrice_knowledge_processing set state='failed',failure='处理多次中断，请重试',lease_token=null,lease_until=null,updated_at=clock_timestamp()
      where state='processing' and lease_until<clock_timestamp() and attempts>=3`;
    const [row] =
      await tx`select p.revision_id,r.file_name,o.* from allrice_knowledge_processing p
      join allrice_knowledge_revisions r on r.id=p.revision_id and r.status='published'
      join allrice_knowledge_sources s on s.id=r.knowledge_source_id and s.ownership is not null and s.status='active'
      join allrice_storage_objects o on o.id=r.file_object_id and o.state='ready' and o.deleted_at is null
      join allrice_organizations org on org.id=s.organization_id and org.archived_at is null
      where p.state='saved' or (p.state='processing' and p.lease_until<clock_timestamp() and p.attempts<3)
      order by p.updated_at,p.revision_id limit 1 for update of p skip locked`;
    if (!row) return null;
    const token = randomUUID();
    await tx`update allrice_knowledge_processing set state='processing',attempts=attempts+1,lease_token=${token},lease_until=clock_timestamp()+interval '5 minutes',failure=null,updated_at=clock_timestamp() where revision_id=${row.revision_id}`;
    const object: StorageObject = {
      id: row.id,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      ownerId: row.owner_id,
      key: row.object_key,
      checksum: row.checksum,
      mediaType: row.media_type,
      sizeBytes: Number(row.size_bytes),
      retentionUntil: row.retention_until?.toISOString() ?? null,
      deletedAt: null,
      immutable: row.immutable,
    };
    return {
      revisionId: row.revision_id as string,
      token,
      object,
      fileName: row.file_name as string,
    };
  });
}
export type ReferenceProcessingClaim = NonNullable<
  Awaited<ReturnType<typeof claimReferenceProcessing>>
>;

export async function finishReferenceProcessing(
  claim: ReferenceProcessingClaim,
  chunks: { content: string; start: number; end: number }[],
) {
  if (!chunks.length) throw new Error('资料没有可检索的文本');
  return getDatabase().begin(async (tx) => {
    const [organization] =
      await tx`select id from allrice_organizations where id=${claim.object.organizationId} and archived_at is null for share`;
    if (!organization) throw new Error('资料已停用');
    // Match maintenance lock order: source -> revision -> processing -> index.
    const [s] =
      await tx`select s.* from allrice_knowledge_sources s join allrice_knowledge_revisions r on r.knowledge_source_id=s.id
      where r.id=${claim.revisionId} for share of s`;
    if (!s || s.status !== 'active' || !s.ownership)
      throw new Error('资料已停用');
    const ownership = ContentOwnershipSchema.parse(s.ownership);
    if (ownership.scope === 'department') {
      const [department] =
        await tx`select id from allrice_departments where organization_id=${ownership.organizationId} and id=${ownership.departmentId} and archived_at is null for share`;
      if (!department) throw new Error('资料已停用');
    }
    const [r] =
      await tx`select * from allrice_knowledge_revisions where id=${claim.revisionId} and status='published' for share`;
    const [p] =
      await tx`select * from allrice_knowledge_processing where revision_id=${claim.revisionId} and state='processing'
      and lease_token=${claim.token} and lease_until>clock_timestamp() for update`;
    if (!r || !p || r.file_object_id !== claim.object.id)
      throw new Error('处理租期或资料版本已变化');
    const [o] =
      await tx`select * from allrice_storage_objects where id=${r.file_object_id} and state='ready' and checksum=${claim.object.checksum}
      and size_bytes=${claim.object.sizeBytes} and object_key=${claim.object.key} for share`;
    if (!o) throw new Error('资料文件校验失败');
    const document = KnowledgeIndexDocumentSchema.parse({
      knowledgeRevisionId: r.id,
      sourceRef: 'file:' + o.id,
      // Existing document FK uses the physical source namespace. The immutable
      // revision holds the retained object when a later uploader uses another workspace.
      storageObjectId: o.workspace_id === r.workspace_id ? o.id : null,
      ownerId: o.owner_id,
      visibility: 'private',
      title: r.file_name,
      mediaType: o.media_type,
      checksum: o.checksum,
      updatedAt: r.created_at.toISOString(),
      chunks,
    });
    await writeKnowledgeDocument(
      tx,
      r.organization_id,
      r.workspace_id,
      document,
    );
    await tx`update allrice_knowledge_processing set state='ready',failure=null,indexed_at=clock_timestamp(),lease_token=null,lease_until=null,updated_at=clock_timestamp() where revision_id=${r.id}`;
  });
}

export async function failReferenceProcessing(
  claim: ReferenceProcessingClaim,
  failure: string,
  unsupported = false,
) {
  await getDatabase()`update allrice_knowledge_processing set state=${unsupported ? 'unsupported' : 'failed'},failure=${failure.slice(0, 300)},lease_token=null,lease_until=null,updated_at=clock_timestamp()
    where revision_id=${claim.revisionId} and lease_token=${claim.token} and state='processing'`;
}
