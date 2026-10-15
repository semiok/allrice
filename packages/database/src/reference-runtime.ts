import { isDeepStrictEqual } from 'node:util';
import type postgres from 'postgres';
import type { OrganizationSharedReader } from './organization-shared-reader.ts';
import {
  KnowledgeRetrievalResultSchema,
  ReferenceSelectionSchema,
  ReferenceSelectionsSchema,
  UuidSchema,
  type ReferenceSelection,
  type KnowledgeRetrievalResult,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  type ContentIdentity,
  readContentPrincipal,
} from './content-maintenance.ts';
import { referenceSourceAccess } from './reference-library.ts';
import { assertLegacyReferenceRevision } from './reference-company-templates.ts';
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
export async function readReferenceSelection(
  context: ContentIdentity,
  revisionId: string,
  sql: Sql,
  lock: boolean,
  sharedReader?: OrganizationSharedReader,
) {
  try {
    const [locator] =
      await sql`select knowledge_source_id from allrice_knowledge_revisions
      where id=${UuidSchema.parse(revisionId)} and file_object_id is not null and status='published'`;
    if (!locator) throw new ReferenceRuntimeError();
    const { source, ownership, legacy } = await referenceSourceAccess(
      context,
      locator.knowledge_source_id,
      sql,
      false,
      lock,
      false,
      sharedReader,
    );
    if (source.status !== 'active') throw new ReferenceRuntimeError();
    if (legacy) await assertLegacyReferenceRevision(sql, revisionId, legacy.id);
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
    selections.push(
      (await readReferenceSelection(context, id, sql, true)).selection,
    );
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
    const current = await readReferenceSelection(
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

/** Tokenize this bounded reference query without changing the existing index.
 * The legacy hash embedding treats a full Chinese sentence as one token. Use
 * lexical candidates (Han bigrams and words) before vector ranking so unrelated
 * hash collisions cannot be described as a relevant automatic retrieval. */
export function referenceQueryTerms(query: string) {
  const ignored = new Set([
    '请帮',
    '帮我',
    '一下',
    '进行',
    '完成',
    '请用',
    '使用',
    '根据',
    '相关',
    '资料',
    '参考',
    '内容',
    '生成',
    '文件',
    '报告',
    '输出',
    'the',
    'and',
    'for',
    'this',
    'that',
    'with',
    'from',
    'please',
  ]);
  const terms = new Set<string>();
  for (const word of query
    .normalize('NFKC')
    .toLowerCase()
    .match(/[\p{Script=Han}]+|[a-z0-9_]{2,}/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const characters = Array.from(word);
      for (let i = 0; i + 1 < characters.length; i++) {
        const term = characters[i]! + characters[i + 1]!;
        if (!ignored.has(term)) terms.add(term);
      }
    } else if (!ignored.has(word)) terms.add(word);
    if (terms.size >= 64) break;
  }
  return [...terms].slice(0, 64);
}

/** Caller owns the principal/content/lease transaction. Ready without a
 * matching index fails explicitly; a valid index with no relevant hit is empty.
 * No file-owner or workspace-file ACL is substituted for the current reader. */
export async function retrieveReferenceKnowledgeInTransaction(
  input: {
    context: ContentIdentity;
    selections: ReferenceSelection[];
    query: string;
    mode: 'explicit' | 'automatic';
  },
  tx: Sql,
): Promise<KnowledgeRetrievalResult[]> {
  if (input.selections.length > (input.mode === 'explicit' ? 3 : 128))
    throw new ReferenceRuntimeError();
  const terms = referenceQueryTerms(input.query);
  const vector = `[${embedKnowledgeText(input.query).join(',')}]`;
  const results: { result: KnowledgeRetrievalResult; matches: number }[] = [];
  for (const selection of [...input.selections].sort((a, b) =>
    a.revisionId.localeCompare(b.revisionId),
  )) {
    const current = await readReferenceSelection(
      input.context,
      selection.revisionId,
      tx,
      true,
    );
    if (!isDeepStrictEqual(current.selection, selection))
      throw new ReferenceRuntimeError();
    const rows =
      await tx`select c.id,c.content,c.locator,d.id as document_id,d.source_updated_at,
      greatest(-1,least(1,1-(c.embedding<=>${vector}::vector))) as score,
      (select count(*) from unnest(${tx.array(terms)}::text[]) q(term)
        where strpos(lower(c.content),q.term)>0) as matches
      from allrice_knowledge_documents d join allrice_knowledge_chunks c on c.document_id=d.id
        and c.organization_id=d.organization_id and c.workspace_id=d.workspace_id
      where d.knowledge_revision_id=${selection.revisionId} and d.active
        and d.organization_id=${current.organizationId} and d.workspace_id=${current.workspaceId}
        and d.source_ref=${'file:' + current.objectId} and d.checksum=${selection.checksum}
      order by ${input.mode === 'automatic' ? tx`matches desc,` : tx``} score desc,c.id limit 2`;
    if (!rows.length) throw new ReferenceRuntimeError();
    for (const row of rows) {
      if (input.mode === 'automatic' && !Number(row.matches)) continue;
      results.push({
        matches: Number(row.matches),
        result: KnowledgeRetrievalResultSchema.parse({
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
      });
    }
  }
  if (input.mode === 'automatic')
    results.sort(
      (a, b) =>
        b.matches - a.matches ||
        b.result.citation.score - a.result.citation.score ||
        a.result.citation.id.localeCompare(b.result.citation.id),
    );
  return results.slice(0, 6).map((r) => r.result);
}

/** The user's explicit selection supplies relevance. Historical callers keep
 * the same at-most-three-source behavior; employee Runs also persist receipts. */
export async function retrieveSelectedReferenceKnowledge(input: {
  context: ContentIdentity;
  selections: ReferenceSelection[];
  query: string;
}) {
  if (!input.selections.length) return [];
  const selections = ReferenceSelectionsSchema.parse(input.selections);
  return getDatabase().begin(async (tx) => {
    if (!(await readContentPrincipal(input.context, tx, true)))
      throw new ReferenceRuntimeError();
    return retrieveReferenceKnowledgeInTransaction(
      { ...input, selections, mode: 'explicit' },
      tx,
    );
  });
}
