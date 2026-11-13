import { randomUUID } from 'node:crypto';
import {
  ContentOwnershipSchema,
  KnowledgeIndexDocumentSchema,
  type StorageObject,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { writeKnowledgeDocument } from './memory/knowledge-retrieval.ts';
import {
  legacyReferenceAuthority,
  assertLegacyReferenceRevision,
} from './reference-company-templates.ts';
import {
  validateReferenceFullText,
  writeReferenceFullText,
  type ReferenceFullText,
} from './reference-fulltext.ts';
export type { ReferenceFullText } from './reference-fulltext.ts';
export { isIndexableReferenceSource } from './reference-fulltext.ts';

/** Old callers only claim the original queue; the new Worker opts into backfill. */
export async function claimReferenceProcessing(
  includeFullTextBackfill = false,
) {
  return getDatabase().begin(async (tx) => {
    await tx`update allrice_knowledge_processing set state='failed',failure='处理多次中断，请重试',lease_token=null,lease_until=null,updated_at=clock_timestamp()
      where state='processing' and lease_until<clock_timestamp() and attempts>=3`;
    if (includeFullTextBackfill)
      await tx`update allrice_knowledge_processing set failure='处理多次中断，请重试',lease_token=null,lease_until=null,updated_at=clock_timestamp()
        where state='ready' and lease_until<clock_timestamp() and attempts>=3`;
    const [row] =
      await tx`select p.revision_id,p.state as processing_state,r.file_name,o.* from allrice_knowledge_processing p
      join allrice_knowledge_revisions r on r.id=p.revision_id and r.status='published'
      join allrice_knowledge_sources s on s.id=r.knowledge_source_id and s.ownership is not null and s.status='active'
      join allrice_storage_objects o on o.id=r.file_object_id and o.state='ready' and o.deleted_at is null
      join allrice_organizations org on org.id=s.organization_id and org.archived_at is null
      left join allrice_company_assets a on a.id=s.legacy_company_asset_id
      where (s.legacy_company_asset_id is null or a.state='published')
      and (p.state='saved' or (p.state='processing' and p.lease_until<clock_timestamp() and p.attempts<3)
        or (${includeFullTextBackfill} and p.state='ready' and p.failure is null
          and (p.lease_token is null or (p.lease_until<clock_timestamp() and p.attempts<3))
          and exists(select 1 from allrice_knowledge_documents d where d.knowledge_revision_id=r.id
            and d.source_ref='file:'||o.id::text and d.checksum=o.checksum and d.full_text is null)))
      order by (p.state='ready'),p.updated_at,p.revision_id limit 1 for update of p skip locked`;
    if (!row) return null;
    const token = randomUUID();
    const backfill = row.processing_state === 'ready';
    await tx`update allrice_knowledge_processing set state=${backfill ? 'ready' : 'processing'},attempts=attempts+1,lease_token=${token},lease_until=clock_timestamp()+interval '5 minutes',failure=null,updated_at=clock_timestamp() where revision_id=${row.revision_id}`;
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
      ...(backfill ? { backfill: true as const } : {}),
    };
  });
}
export type ReferenceProcessingClaim = NonNullable<
  Awaited<ReturnType<typeof claimReferenceProcessing>>
>;

export async function finishReferenceProcessing(
  claim: ReferenceProcessingClaim,
  chunks: { content: string; start: number; end: number }[],
  fullTextInput?: ReferenceFullText,
) {
  if (!chunks.length) throw new Error('资料没有可检索的文本');
  const fullText = fullTextInput
    ? validateReferenceFullText(fullTextInput)
    : undefined;
  if (claim.backfill && !fullText) throw new Error('资料正文尚未完整提取');
  return getDatabase().begin(async (tx) => {
    const [organization] =
      await tx`select id from allrice_organizations where id=${claim.object.organizationId} and archived_at is null`;
    if (!organization) throw new Error('资料已停用');
    const [locator] =
      await tx`select knowledge_source_id from allrice_knowledge_revisions where id=${claim.revisionId}`;
    if (!locator) throw new Error('资料已停用');
    const legacy = await legacyReferenceAuthority(
      tx,
      locator.knowledge_source_id,
      false,
    );
    if (legacy)
      await assertLegacyReferenceRevision(tx, claim.revisionId, legacy.id);
    // Background extraction never locks publication/admission authority. The
    // final conditional lease update observes current authority once more.
    const [s] =
      await tx`select s.* from allrice_knowledge_sources s join allrice_knowledge_revisions r on r.knowledge_source_id=s.id
      where r.id=${claim.revisionId}`;
    if (!s || s.status !== 'active' || !s.ownership)
      throw new Error('资料已停用');
    const ownership = ContentOwnershipSchema.parse(s.ownership);
    if (ownership.scope === 'department') {
      const [department] =
        await tx`select id from allrice_departments where organization_id=${ownership.organizationId} and id=${ownership.departmentId} and archived_at is null`;
      if (!department) throw new Error('资料已停用');
    }
    const [r] =
      await tx`select * from allrice_knowledge_revisions where id=${claim.revisionId} and status='published'`;
    const [p] =
      await tx`select * from allrice_knowledge_processing where revision_id=${claim.revisionId} and state=${claim.backfill ? 'ready' : 'processing'}
      and lease_token=${claim.token} and lease_until>clock_timestamp()`;
    if (!r || !p || r.file_object_id !== claim.object.id)
      throw new Error('处理租期或资料版本已变化');
    const [o] =
      await tx`select * from allrice_storage_objects where id=${r.file_object_id} and state='ready' and checksum=${claim.object.checksum}
      and size_bytes=${claim.object.sizeBytes} and object_key=${claim.object.key} and deleted_at is null
      and immutable and (retention_until is null or retention_until>clock_timestamp())`;
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
    if (claim.backfill) {
      // Preserve old chunks, document identity, active flag and read pins.
      const [stored] = await tx`select id from allrice_knowledge_documents
        where knowledge_revision_id=${r.id} and source_ref=${document.sourceRef}
          and checksum=${o.checksum} and full_text is null`;
      if (!stored) throw new Error('处理租期或资料版本已变化');
      await writeReferenceFullText(tx, stored.id, fullText!);
    } else {
      const stored = await writeKnowledgeDocument(
        tx,
        r.organization_id,
        r.workspace_id,
        document,
      );
      if (fullText) await writeReferenceFullText(tx, stored.id, fullText);
    }
    // This is optimistic derived-data publication, not an authorization grant
    // or atomic ordering with revocation. Every read still checks authority.
    // No processing lock is held while documents/chunks are being written.
    const finished = await tx`update allrice_knowledge_processing p
      set state='ready',failure=null,
        indexed_at=${claim.backfill ? tx`p.indexed_at` : tx`clock_timestamp()`},
        lease_token=null,lease_until=null,updated_at=clock_timestamp()
      where p.revision_id=${claim.revisionId} and p.state=${claim.backfill ? 'ready' : 'processing'}
        and p.lease_token=${claim.token} and p.lease_until>clock_timestamp()
        and exists(select 1 from allrice_knowledge_revisions current_revision
          join allrice_knowledge_sources current_source on current_source.id=current_revision.knowledge_source_id
          join allrice_organizations org on org.id=current_source.organization_id and org.archived_at is null
          join allrice_storage_objects current_object on current_object.id=current_revision.file_object_id
          left join allrice_company_assets asset on asset.id=current_source.legacy_company_asset_id
          where current_revision.id=${r.id} and current_revision.knowledge_source_id=${s.id}
            and current_revision.status='published' and current_revision.checksum=${r.checksum}
            and current_source.status='active' and current_source.ownership=${tx.json(ownership)}
            and (current_source.legacy_company_asset_id is null or asset.state='published')
            and (current_source.ownership->>'scope'<>'department' or exists(
              select 1 from allrice_departments department
              where department.id::text=current_source.ownership->>'departmentId'
                and department.organization_id=current_source.organization_id and department.archived_at is null))
            and current_object.id=${claim.object.id} and current_object.organization_id=${claim.object.organizationId}
            and current_object.checksum=${claim.object.checksum} and current_object.size_bytes=${claim.object.sizeBytes}
            and current_object.object_key=${claim.object.key} and current_object.media_type=${claim.object.mediaType}
            and current_object.state='ready' and current_object.immutable and current_object.deleted_at is null
            and (current_object.retention_until is null or current_object.retention_until>clock_timestamp()))
      returning p.revision_id`;
    if (!finished.length) throw new Error('处理租期或资料版本已变化');
  });
}

export async function failReferenceProcessing(
  claim: ReferenceProcessingClaim,
  failure: string,
  unsupported = false,
) {
  await getDatabase()`update allrice_knowledge_processing set state=${claim.backfill ? 'ready' : unsupported ? 'unsupported' : 'failed'},failure=${failure.slice(0, 300)},lease_token=null,lease_until=null,updated_at=clock_timestamp()
    where revision_id=${claim.revisionId} and lease_token=${claim.token}
      and state=${claim.backfill ? 'ready' : 'processing'}`;
}
