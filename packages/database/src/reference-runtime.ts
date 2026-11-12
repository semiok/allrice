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
  type ContentOwnership,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  type ContentIdentity,
  readContentPrincipal,
} from './content-maintenance.ts';
import { referenceSourceAccess } from './reference-library.ts';
import { assertLegacyReferenceRevision } from './reference-company-templates.ts';
import { workbenchFileAccess } from './workbench-file-access.ts';
import { embedKnowledgeText } from './memory/knowledge-retrieval.ts';

type Sql = ReturnType<typeof getDatabase> | postgres.TransactionSql;
export class ReferenceRuntimeError extends Error {
  readonly code = 'REFERENCE_UNAVAILABLE';
  constructor() {
    super('所选资料尚未就绪、已撤回或访问权限已变化，请重新选择资料。');
  }
}
/** Internal source identity, not another wire error or persisted lifecycle. */
export class ReferencePublicationRuntimeError extends ReferenceRuntimeError {}

/** The immutable revision is a pin, never an authorization token. A reader
 * needs no maintenance privilege and never inherits the uploader's authority. */
export async function readReferenceSelection(
  context: ContentIdentity,
  revisionId: string,
  sql: Sql,
  lock: boolean,
  sharedReader?: OrganizationSharedReader,
) {
  let publicationSource = false;
  try {
    const [locator] =
      await sql`select r.knowledge_source_id,s.publication_kind from allrice_knowledge_revisions r
      join allrice_knowledge_sources s on s.id=r.knowledge_source_id
      where r.id=${UuidSchema.parse(revisionId)} and r.file_object_id is not null and r.status='published'
        and s.organization_id=${context.organizationId}`;
    if (!locator) throw new ReferenceRuntimeError();
    publicationSource = !!locator.publication_kind;
    const { source, ownership, legacy, publication, access } =
      await referenceSourceAccess(
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
      publication,
      access,
    };
  } catch (error) {
    if (
      publicationSource &&
      (error instanceof DataAccessError ||
        error instanceof ReferenceRuntimeError)
    )
      throw new ReferencePublicationRuntimeError();
    if (error instanceof DataAccessError) throw new ReferenceRuntimeError();
    throw error;
  }
}

/** Current audience is deliberately outside the immutable selection. Changing
 * scope must not change a digest/pin or invalidate readers who kept access. */
export function canReferencePublicationScope(
  target: ContentOwnership,
  publication: NonNullable<
    Awaited<ReturnType<typeof readReferenceSelection>>['publication']
  >,
) {
  if (
    target.scope === 'platform' ||
    target.organizationId !== publication.organization_id
  )
    return false;
  if (publication.scope === 'company') return true;
  if (target.scope === 'personal')
    return (
      publication.scope !== 'personal' ||
      publication.owner_id === target.ownerId
    );
  return (
    target.scope === 'department' &&
    publication.scope === 'departments' &&
    publication.department_ids.includes(target.departmentId)
  );
}

/** Follow exact frozen inputs, never all Runs that happen to share a native
 * generation today. A prior Run's frozen conversation links carry its actual
 * predecessor dependencies without admitting a source Session's future Runs.
 * User text follows its frozen predecessors, not that Run's later reads or
 * model-only session-reference inputs. Roles come from exact message identity. */
export async function referencePublicationDependencyRuns(
  context: ContentIdentity,
  sessionId: string,
  sql: Sql,
  messageIds?: readonly string[],
  includeUserRuns = false,
) {
  if (messageIds && !messageIds.length) return [];
  const runs = await sql<{ run_id: string }[]>`
    with recursive dependencies(run_id,include_reads) as (
      select er.run_id,${messageIds ? sql`er.assistant_message_id in ${sql([...messageIds])}` : sql`true`} from allrice_employee_runs er
      where er.organization_id=${context.organizationId} and er.workspace_id=${context.workspaceId}
        and er.owner_id=${context.actor.id} and er.session_id=${UuidSchema.parse(sessionId)}
        and er.error_code is distinct from 'STEER_CONSUMED'
        ${messageIds ? sql`and (er.user_message_id in ${sql([...messageIds])} or er.assistant_message_id in ${sql([...messageIds])})` : sql``}
      union
      select related.run_id,related.include_reads from dependencies d
      join allrice_employee_runs er_current on er_current.run_id=d.run_id
      cross join lateral (
        select e.run_id,(e.assistant_message_id::text=message->>'id') as include_reads from jsonb_array_elements(case when jsonb_typeof(er_current.prompt_snapshot->'conversation')='array'
          then er_current.prompt_snapshot->'conversation' else '[]'::jsonb end) message
        join allrice_employee_runs e on e.session_id=er_current.session_id
          and e.content_generation_id=er_current.content_generation_id
          and (e.user_message_id::text=message->>'id' or e.assistant_message_id::text=message->>'id')
          and e.organization_id=er_current.organization_id and e.workspace_id=er_current.workspace_id
          and e.owner_id=er_current.owner_id and e.error_code is distinct from 'STEER_CONSUMED'
        union
        select e.run_id,(e.assistant_message_id::text=message->>'id') as include_reads from jsonb_array_elements(case when jsonb_typeof(er_current.prompt_snapshot->'sessionReferences')='array'
          then er_current.prompt_snapshot->'sessionReferences' else '[]'::jsonb end) ref
        cross join lateral jsonb_array_elements(case when jsonb_typeof(ref->'messages')='array'
          then ref->'messages' else '[]'::jsonb end) message
        join allrice_employee_runs e on e.session_id::text=ref->>'sessionId'
          and (e.user_message_id::text=message->>'id' or e.assistant_message_id::text=message->>'id')
          and e.organization_id=er_current.organization_id and e.workspace_id=er_current.workspace_id
          and e.error_code is distinct from 'STEER_CONSUMED'
        where d.include_reads
      ) related
    ) select distinct run_id from dependencies where ${includeUserRuns ? sql`true` : sql`include_reads`} order by run_id`;
  return runs.map((r) => r.run_id);
}

async function publicationHistoryAccess(
  context: ContentIdentity,
  sessionId: string,
  sql: Sql,
  lock: boolean,
  currentAccess: boolean,
  messageIds?: readonly string[],
) {
  const runs = await referencePublicationDependencyRuns(
    context,
    sessionId,
    sql,
    messageIds,
  );
  if (!runs.length) return { used: false, canRead: true, revoked: false };
  const [read] = await sql`select 1 from allrice_employee_runs er
    cross join lateral jsonb_array_elements(coalesce(er.reference_reads,'[]'::jsonb)) receipt
    where er.run_id in ${sql(runs)} limit 1`;
  if (!read) return { used: false, canRead: true, revoked: false };
  const used = await sql<{ id: string }[]>`
    select distinct s.id from allrice_employee_runs er
    cross join lateral jsonb_array_elements(coalesce(er.reference_reads,'[]'::jsonb)) receipt
    join allrice_knowledge_revisions r on r.id::text=receipt->'citation'->'reference'->>'revisionId'
      and r.knowledge_source_id::text=receipt->'citation'->'reference'->>'sourceId'
      and r.checksum=receipt->'citation'->'reference'->>'digest'
    join allrice_storage_objects retained on retained.id=r.file_object_id
      and retained.checksum=receipt->'citation'->'reference'->>'checksum'
    join allrice_knowledge_sources s on s.id=r.knowledge_source_id
      and s.organization_id=${context.organizationId} and s.publication_kind is not null
    where er.run_id in ${sql(runs)} order by s.id`;
  if (!used.length) return { used: false, canRead: true, revoked: false };
  // Only the narrow identity/source/policy gates run under the queue's existing
  // root/Job prefix. No Session, generation, runtime or background locks follow.
  // Identity precedes sources, matching publication/authority writers.
  const principal = currentAccess
    ? await readContentPrincipal(context, sql, lock)
    : null;
  const sources = await sql<{ id: string; status: string }[]>`
    select s.id,s.status from allrice_knowledge_sources s
    where s.id in ${sql(used.map((s) => s.id))}
    order by s.id ${lock ? sql`for share of s` : sql``}`;
  let canRead =
      sources.length === used.length && (!currentAccess || principal !== null),
    revoked = false;
  for (const source of sources) {
    if (source.status !== 'active') canRead = false;
    if (source.status === 'archived') {
      // Re-read after the source lock wait, not an action subquery evaluated
      // using the statement snapshot that preceded the withdrawal commit.
      const [action] =
        await sql`select source_id from allrice_knowledge_reference_actions
        where source_id=${source.id} and input->>'action' in ('revoke','delete') limit 1`;
      revoked ||= !!action;
    }
    if (currentAccess && canRead) {
      const [policy] = await sql<{ object_id: string }[]>`
        select p.object_id from allrice_workbench_file_policies p
        join allrice_knowledge_revisions r on r.file_object_id=p.object_id and r.knowledge_source_id=p.reference_source_id
        where p.reference_source_id=${source.id}`;
      canRead =
        !!policy &&
        !!(await workbenchFileAccess(context, policy.object_id, sql, lock))
          ?.canRead;
    }
  }
  return { used: true, canRead, revoked };
}

/** Current loss stops only this visible commit. It never writes permanent
 * invalidation or turns an audience edit into a revoke/delete fact. */
export function readReferencePublicationHistoryAccess(
  context: ContentIdentity,
  sessionId: string,
  sql: Sql,
  lock = false,
) {
  return publicationHistoryAccess(context, sessionId, sql, lock, true);
}

/** Own Session history is permanent Q8; external frozen message checks pass
 * exact message IDs so future Runs cannot be added retroactively. */
export async function hasRevokedReferencePublicationHistory(
  context: ContentIdentity,
  sessionId: string,
  sql: Sql = getDatabase(),
  lock = false,
  messageIds?: readonly string[],
) {
  return (
    await publicationHistoryAccess(
      context,
      sessionId,
      sql,
      lock,
      false,
      messageIds,
    )
  ).revoked;
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
      throw current.publication
        ? new ReferencePublicationRuntimeError()
        : new ReferenceRuntimeError();
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
