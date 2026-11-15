import { createHash, randomUUID } from 'node:crypto';
import {
  ReferenceUploadInputSchema,
  type ContentOwnership,
  type RequestContext,
} from '@allrice/contracts';
import type { getDatabase } from './core/client.ts';
import { createStorageMetadata } from './data.ts';

/** Isolated pre-R0 rows for read/history tests. This bypasses the retired write
 * entrypoints deliberately; it does not implement their validation or replay. */
export async function legacyReferenceFixture(
  context: RequestContext,
  input: unknown,
  db: ReturnType<typeof getDatabase>,
  origin?: {
    versionId: string;
    snapshot: Record<string, string | number>;
  },
) {
  const value = ReferenceUploadInputSchema.parse(input);
  const bytes = Buffer.from(value.contentBase64, 'base64');
  const checksum =
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const sourceId = value.sourceId ?? randomUUID();
  let ownership: ContentOwnership =
    value.scope === 'platform'
      ? { scope: 'platform' }
      : value.scope === 'personal'
        ? {
            scope: 'personal',
            organizationId: context.organizationId,
            ownerId: context.actor.id,
          }
        : value.scope === 'company'
          ? { scope: 'company', organizationId: context.organizationId }
          : {
              scope: 'department',
              organizationId: context.organizationId,
              departmentId: value.departmentId!,
            };
  if (!value.sourceId)
    await db`insert into allrice_knowledge_sources(id,organization_id,workspace_id,slug,name,description,created_by,ownership)
      values(${sourceId},${context.organizationId},${value.workspaceId},${'legacy-fixture-' + sourceId},${value.fileName},${value.purpose},${context.actor.id},${db.json(ownership)})`;
  else {
    const [source] =
      await db`select ownership from allrice_knowledge_sources where id=${sourceId}`;
    if (!source) throw Error('Missing legacy source fixture');
    ownership = source.ownership as ContentOwnership;
  }
  const file = await createStorageMetadata(
    context,
    {
      id: randomUUID(),
      workspaceId: value.workspaceId,
      category: 'uploads',
      mediaType: value.mediaType,
      sizeBytes: bytes.length,
      checksum,
      visibility: 'private',
      immutable: true,
      retentionUntil: null,
    },
    db,
  );
  const revisionId = randomUUID();
  const [next] =
    await db`select coalesce(max(revision),0)+1 as revision from allrice_knowledge_revisions where knowledge_source_id=${sourceId}`;
  const definition = {
    schemaVersion: 1,
    sourceKind: 'managed',
    connectorBindingId: null,
    resourceRef: 'file:' + file.object.id,
    indexing: 'hybrid',
    updatePolicy: 'manual',
    citationRequired: true,
    allowedScopes: [value.scope === 'personal' ? 'user' : 'organization'],
  };
  const digest = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        definition,
        checksum,
        ownership,
        name: value.fileName,
        purpose: value.purpose,
      }),
    )
    .digest('hex')}`;
  await db`insert into allrice_knowledge_revisions(id,organization_id,workspace_id,knowledge_source_id,revision,name,description,status,definition,checksum,created_by,file_object_id,file_name,request_id,request_input,source_artifact_version_id,source_target_key,artifact_snapshot)
    values(${revisionId},${context.organizationId},${value.workspaceId},${sourceId},${next!.revision},${value.fileName},${value.purpose},'draft',${db.json(definition)},${digest},${context.actor.id},${file.object.id},${value.fileName},${value.requestId},${db.json(value)},${origin?.versionId ?? null},${origin ? 'legacy-fixture:' + sourceId : null},${origin ? db.json(origin.snapshot) : null})`;
  await db`update allrice_knowledge_revisions set status='published',published_at=clock_timestamp() where id=${revisionId}`;
  await db`insert into allrice_knowledge_processing(revision_id) values(${revisionId})`;
  return {
    sourceId,
    revisionId,
    object: file.object,
    bytes,
    alreadyReady: false,
  };
}
