import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import {
  KnowledgeRetrievalResultSchema,
  ReferenceSelectionSchema,
  ReferenceSelectionsSchema,
  UuidSchema,
  type ReferenceSelection,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  type ContentIdentity,
  readContentPrincipal,
} from './content-maintenance.ts';
import { referenceSourceAccess } from './reference-library.ts';
import { embedKnowledgeText } from './memory/knowledge-retrieval.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
export class ReferenceRuntimeError extends Error {
  readonly code = 'REFERENCE_UNAVAILABLE';
  constructor() {
    super('所选资料尚未就绪、已撤回或访问权限已变化，请重新选择资料。');
  }
}

/** The immutable revision is a pin, never an authorization token. A reader
 * needs no maintenance privilege and never inherits the uploader's authority. */
async function readSelection(
  context: ContentIdentity,
  revisionId: string,
  sql: Sql,
  lock: boolean,
) {
  try {
    const [locator] =
      await sql`select knowledge_source_id from allrice_knowledge_revisions
      where id=${UuidSchema.parse(revisionId)} and file_object_id is not null and status='published'`;
    if (!locator) throw new ReferenceRuntimeError();
    const { source, ownership } = await referenceSourceAccess(
      context,
      locator.knowledge_source_id,
      sql,
      false,
      lock,
    );
    if (source.status !== 'active') throw new ReferenceRuntimeError();
    const [r] =
      await sql`select * from allrice_knowledge_revisions where id=${revisionId}
      and knowledge_source_id=${source.id} and status='published' ${lock ? sql`for share` : sql``}`;
    if (!r?.file_object_id) throw new ReferenceRuntimeError();
    const [p] = await sql`select revision_id from allrice_knowledge_processing
      where revision_id=${revisionId} and state='ready' ${lock ? sql`for share` : sql``}`;
    const [o] =
      await sql`select id,checksum from allrice_storage_objects where id=${r.file_object_id}
      and state='ready' and immutable and deleted_at is null
      and (retention_until is null or retention_until>clock_timestamp()) ${lock ? sql`for share` : sql``}`;
    if (!p || !o) throw new ReferenceRuntimeError();
    return {
      selection: ReferenceSelectionSchema.parse({
        sourceId: source.id,
        revisionId: r.id,
        revision: r.revision,
        fileName: r.file_name,
        purpose: r.description,
        digest: r.checksum,
        checksum: o.checksum,
        ownership,
      }),
      objectId: o.id as string,
      organizationId: r.organization_id as string,
      workspaceId: r.workspace_id as string,
    };
  } catch (error) {
    if (error instanceof DataAccessError) throw new ReferenceRuntimeError();
    throw error;
  }
}

export async function captureReferenceSelections(
  context: ContentIdentity,
  revisionIds: readonly string[],
  sql: Sql,
) {
  if (
    revisionIds.length > 3 ||
    new Set(revisionIds).size !== revisionIds.length
  )
    throw new ReferenceRuntimeError();
  const selections: ReferenceSelection[] = [];
  for (const id of [...revisionIds].sort())
    selections.push((await readSelection(context, id, sql, true)).selection);
  return selections;
}

export async function assertReferenceSelections(
  context: ContentIdentity,
  raw: unknown,
  sql: Sql,
  lock = false,
) {
  const selections = ReferenceSelectionsSchema.parse(raw ?? []);
  for (const selection of [...selections].sort((a, b) =>
    a.revisionId.localeCompare(b.revisionId),
  )) {
    const current = await readSelection(
      context,
      selection.revisionId,
      sql,
      lock,
    );
    if (!isDeepStrictEqual(current.selection, selection))
      throw new ReferenceRuntimeError();
  }
  return selections;
}

/** Reuse the retained revision's verified index in its source namespace. The
 * user's explicit selection supplies relevance; return bounded excerpts, not
 * an assertion that the whole file was read. No workspace-file ACL bypass. */
export async function retrieveSelectedReferenceKnowledge(input: {
  context: ContentIdentity;
  selections: ReferenceSelection[];
  query: string;
}) {
  if (!input.selections.length) return [];
  const selections = ReferenceSelectionsSchema.parse(input.selections);
  const vector = `[${embedKnowledgeText(input.query).join(',')}]`;
  return getDatabase().begin(async (tx) => {
    if (!(await readContentPrincipal(input.context, tx, true)))
      throw new ReferenceRuntimeError();
    const results = [];
    for (const selection of [...selections].sort((a, b) =>
      a.revisionId.localeCompare(b.revisionId),
    )) {
      const current = await readSelection(
        input.context,
        selection.revisionId,
        tx,
        true,
      );
      if (!isDeepStrictEqual(current.selection, selection))
        throw new ReferenceRuntimeError();
      const rows =
        await tx`select c.id,c.content,c.locator,d.id as document_id,d.source_updated_at,
          greatest(-1,least(1,1-(c.embedding<=>${vector}::vector))) as score
        from allrice_knowledge_documents d join allrice_knowledge_chunks c on c.document_id=d.id
          and c.organization_id=d.organization_id and c.workspace_id=d.workspace_id
        where d.knowledge_revision_id=${selection.revisionId} and d.active
          and d.organization_id=${current.organizationId} and d.workspace_id=${current.workspaceId}
          and d.source_ref=${'file:' + current.objectId} and d.checksum=${selection.checksum}
        order by score desc,c.id limit 2`;
      if (!rows.length) throw new ReferenceRuntimeError();
      for (const row of rows)
        results.push(
          KnowledgeRetrievalResultSchema.parse({
            content: row.content,
            citation: {
              type: 'knowledge',
              id: row.id,
              label: `${selection.fileName} · v${selection.revision}`,
              knowledgeRevisionId: selection.revisionId,
              documentId: row.document_id,
              sourceKind: 'managed',
              scope: 'user',
              locator: row.locator,
              updatedAt: row.source_updated_at.toISOString(),
              score: Number(row.score),
              reference: selection,
            },
          }),
        );
    }
    return results;
  });
}
