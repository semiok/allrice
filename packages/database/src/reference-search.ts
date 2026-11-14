import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { z } from 'zod';
import {
  KnowledgeRetrievalResultSchema,
  ReferencePublicationQuerySchema,
  ReferencePublicationQueryResultSchema,
  ReferenceReadInputSchema,
  ReferenceSearchInputSchema,
  referenceSearchPolicy,
  type ReferenceRevision,
  type ReferencePublicationQuery,
  type ReferenceTextLocation,
} from '@allrice/contracts';
import { getDatabase } from './core/client.ts';
import { DataAccessError } from './data.ts';
import {
  readContentPrincipal,
  type ContentIdentity,
} from './content-maintenance.ts';
import {
  listReferencePublications,
  referenceSourceAccess,
} from './reference-library.ts';
import { runtimePolicyDigest } from './runtime-policy.ts';
import {
  readReferenceSelection,
  ReferenceRuntimeError,
} from './reference-runtime.ts';
import {
  validateReferenceFullText,
  type ReferenceFullText,
} from './reference-fulltext.ts';

export class ReferenceFullTextUnavailableError extends ReferenceRuntimeError {
  readonly reason = 'full_text_unavailable';
}

export class ReferenceToolResultLimitError extends Error {
  readonly code = 'TOOL_RESULT_TOO_LARGE';
  constructor() {
    super('企业资料结果超过内联上限，请减少 limit 后继续读取。');
  }
}

export class ReferenceReadOffsetError extends Error {
  readonly code = 'TOOL_INPUT_INVALID';
  constructor() {
    super(
      '读取起点超出资料正文长度，请使用返回的 nextOffset 或 totalCharacters。',
    );
  }
}

/** Sensitive text is never exported to an ordinary file to evade source ACLs. */
export function boundedReferenceToolResult(value: unknown) {
  const text = JSON.stringify(value);
  if (text.length > referenceSearchPolicy.maximumInlineCharacters)
    throw new ReferenceToolResultLimitError();
  return text;
}

function queryDigest(
  context: ContentIdentity,
  query: ReferencePublicationQuery,
) {
  return (
    'sha256:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          context.organizationId,
          context.workspaceId,
          context.actor.id,
          query.query,
          query.category,
          query.sourceId ?? null,
        ]),
      )
      .digest('hex')
  );
}

function inCategory(
  reference: ReferenceRevision,
  query: ReferencePublicationQuery,
  ownerId: string,
) {
  const publication = reference.publication!;
  return (
    query.category === 'all' ||
    (query.category === 'mine' && publication.publisherId === ownerId) ||
    (query.category === 'company' &&
      publication.audience.scope === 'company') ||
    (query.category === 'departments' &&
      publication.audience.scope === 'departments')
  );
}

function compareReferences(left: ReferenceRevision, right: ReferenceRevision) {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    left.sourceId.localeCompare(right.sourceId)
  );
}

/** SQL LIKE syntax is escaped as data; no query-language or intent parser. */
function containsPattern(query: string) {
  return (
    '%' +
    query
      .replaceAll('\\', '\\\\')
      .replaceAll('%', '\\%')
      .replaceAll('_', '\\_') +
    '%'
  );
}

function textMatchOffset(text: string, query: string) {
  const foldedOffset = text.toLowerCase().indexOf(query.toLowerCase());
  if (foldedOffset < 0) return -1;
  // Unicode case folding can change length (e.g. İ). Translate the match back
  // to the original UTF-16 text; citations never index into a folded copy.
  let folded = 0,
    original = 0;
  for (const character of text) {
    if (folded >= foldedOffset) break;
    folded += character.toLowerCase().length;
    original += character.length;
  }
  return original;
}

/** Same current publication reader as F3. All filtering/counts/pagination happen
 * after current authorization. This never records a model read or holds any
 * realtime authority lock while scanning complete text. */
export async function queryReferencePublications(
  context: ContentIdentity,
  input: unknown,
) {
  const prepared = await preparePublicationQuery(context, input);
  return getDatabase().begin(async (tx) => {
    await assertPreparedReferencesReadable(
      context,
      prepared.dependencies,
      prepared.texts,
      tx,
    );
    return prepared.page;
  });
}

async function preparePublicationQuery(
  context: ContentIdentity,
  input: unknown,
  includeMatches = true,
) {
  const query = ReferencePublicationQuerySchema.parse(input);
  if (!context.workspaceId || !(await readContentPrincipal(context)))
    throw new DataAccessError('authorization_denied');
  const digest = queryDigest(context, query);
  if (query.cursor && query.cursor.queryDigest !== digest)
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['cursor'],
        message: 'Cursor belongs to another query or reader',
      },
    ]);
  const authorized = (
    await listReferencePublications(
      context,
      context.workspaceId,
      query.sourceId,
    )
  ).filter((reference) => inCategory(reference, query, context.actor.id));
  const sql = getDatabase();
  let candidates = authorized;
  if (query.query && authorized.length) {
    const pattern = containsPattern(query.query);
    const matches = await sql<{ revision_id: string }[]>`
      select r.id as revision_id from allrice_knowledge_revisions r
      join allrice_knowledge_sources s on s.id=r.knowledge_source_id
      join allrice_storage_objects o on o.id=r.file_object_id
      join allrice_knowledge_processing p on p.revision_id=r.id
      where r.id in ${sql(authorized.map((reference) => reference.revisionId))}
        and s.publication_kind is not null and s.status='active' and r.status='published'
        and (r.file_name ilike ${pattern} or r.description ilike ${pattern}
          or (p.state='ready' and o.state='ready' and o.immutable and o.deleted_at is null
            and (o.retention_until is null or o.retention_until>clock_timestamp()) and exists(
              select 1 from allrice_knowledge_documents d
              where d.knowledge_revision_id=r.id and d.active
                and d.organization_id=r.organization_id and d.workspace_id=r.workspace_id
                and d.source_ref='file:'||o.id::text and d.checksum=o.checksum
                and d.full_text is not null and d.full_text_locations is not null
                and d.full_text_metadata is not null and d.full_text ilike ${pattern})))`;
    const ids = new Set(matches.map((row) => row.revision_id));
    candidates = candidates.filter((reference) =>
      ids.has(reference.revisionId),
    );
  }
  // The query may have taken time. Recheck the current reader and exact DTOs
  // before returning titles, counts or cursors. No cached snapshot grants access.
  const current = (
    await listReferencePublications(
      context,
      context.workspaceId,
      query.sourceId,
    )
  ).filter((reference) => inCategory(reference, query, context.actor.id));
  const currentById = new Map(
    current.map((reference) => [reference.revisionId, reference]),
  );
  candidates = candidates
    .flatMap((reference) => {
      const fresh = currentById.get(reference.revisionId);
      return fresh &&
        fresh.checksum === reference.checksum &&
        fresh.manifestDigest === reference.manifestDigest
        ? [fresh]
        : [];
    })
    .sort(compareReferences);
  if (query.cursor) {
    const cursor = query.cursor;
    candidates = candidates.filter(
      (reference) =>
        reference.createdAt < cursor.createdAt ||
        (reference.createdAt === cursor.createdAt &&
          reference.sourceId > cursor.sourceId),
    );
  }
  const references = candidates.slice(0, query.limit);
  const last = references.at(-1);
  const matches = [];
  const texts: PreparedReferenceText[] = [];
  if (query.query && includeMatches)
    for (const reference of references) {
      if (!reference.fullTextReady) continue;
      const prepared = await prepareReferenceText(
        context,
        referenceReadPin(reference),
      );
      texts.push(prepared);
      const at = textMatchOffset(prepared.fullText.text, query.query);
      if (at < 0) continue;
      const excerpt = referenceTextPage(
        prepared,
        at,
        referenceSearchPolicy.excerptCharacters,
      );
      matches.push({
        revisionId: reference.revisionId,
        content: excerpt.content,
        start: excerpt.start,
        end: excerpt.end,
        locations: excerpt.locations,
        warnings: excerpt.warnings,
      });
    }
  const page = ReferencePublicationQueryResultSchema.parse({
    references,
    matches,
    nextCursor:
      candidates.length > references.length && last
        ? {
            queryDigest: digest,
            createdAt: last.createdAt,
            sourceId: last.sourceId,
          }
        : null,
    fullTextCoverage: {
      ready: current.filter((reference) => reference.fullTextReady === true)
        .length,
      unavailable: current.filter(
        (reference) => reference.fullTextReady !== true,
      ).length,
    },
  });
  return { page, dependencies: current, texts };
}

/** Shared final disclosure gate. Full-text scanning/decoding has already
 * finished outside this short transaction; the web path creates no Run/read. */
export async function assertPreparedReferencesReadable(
  context: ContentIdentity,
  dependencies: readonly ReferenceRevision[],
  texts: readonly PreparedReferenceText[],
  tx: postgres.TransactionSql,
) {
  if (!(await readContentPrincipal(context, tx, true)))
    throw new ReferenceRuntimeError();
  const sources = new Set([
    ...dependencies.map((r) => r.sourceId),
    ...texts.map((r) => r.selection.sourceId),
  ]);
  for (const sourceId of [...sources].sort()) {
    const current = await referenceSourceAccess(
      context,
      sourceId,
      tx,
      false,
      true,
    );
    if (
      !current.publication ||
      dependencies.some(
        (r) =>
          r.sourceId === sourceId &&
          r.publication!.audienceRevision !== current.publication!.revision,
      )
    )
      throw new ReferenceRuntimeError();
  }
  // The extractor publishes document changes before its processing CAS. Take
  // document locks before processing locks too, so readers cannot invert it.
  for (const prepared of [...texts].sort((a, b) =>
    a.document.id.localeCompare(b.document.id),
  )) {
    const [document] = await tx`select id from allrice_knowledge_documents
      where id=${prepared.document.id} and xmin::text=${prepared.document.version} and active for share`;
    if (!document) throw new ReferenceRuntimeError();
  }
  // Even a not-ready publication contributes protected metadata/coverage.
  // Recheck its exact pin and ready fact without reading/decoding full text.
  for (const reference of [...dependencies].sort(compareReferences)) {
    const [current] = await tx`select
      case when o.state='pending' then 'uploading' else p.state end as processing,p.failure,
      (p.state='ready' and o.state='ready' and o.immutable and o.deleted_at is null
        and (o.retention_until is null or o.retention_until>clock_timestamp()) and exists(
          select 1 from allrice_knowledge_documents d where d.knowledge_revision_id=r.id and d.active
            and d.organization_id=r.organization_id and d.workspace_id=r.workspace_id
            and d.source_ref='file:'||o.id::text and d.checksum=o.checksum
            and d.full_text is not null and octet_length(d.full_text)>0
            and d.full_text_locations is not null and d.full_text_metadata is not null)) as ready
      from allrice_knowledge_revisions r join allrice_storage_objects o on o.id=r.file_object_id
      join allrice_knowledge_processing p on p.revision_id=r.id
      where r.id=${reference.revisionId} and r.knowledge_source_id=${reference.sourceId}
        and r.status='published' and r.checksum=${referenceReadPin(reference).digest} and o.checksum=${reference.checksum}
      for share of r,o,p`;
    if (
      !current ||
      current.processing !== reference.processing ||
      current.failure !== (reference.failure ?? null) ||
      current.ready !== reference.fullTextReady
    )
      throw new ReferenceRuntimeError();
  }
  for (const prepared of [...texts].sort((a, b) =>
    a.selection.sourceId.localeCompare(b.selection.sourceId),
  )) {
    const current = await readReferenceSelection(
      context,
      prepared.selection.revisionId,
      tx,
      true,
    );
    if (
      !current.publication ||
      runtimePolicyDigest(current.selection) !==
        runtimePolicyDigest(prepared.selection)
    )
      throw new ReferenceRuntimeError();
  }
}

type FullTextRow = {
  id: string;
  version: string;
  full_text: string;
  full_text_locations: {
    units: ReferenceFullText['units'];
    tables?: ReferenceFullText['tables'];
  };
  full_text_metadata: Omit<ReferenceFullText, 'text' | 'units' | 'tables'>;
  source_updated_at: Date;
};

/** Prepared outside the short receipt transaction. Not yet authorized for
 * disclosure: the Run completion gate must recheck this exact source/derivation. */
export async function prepareReferenceText(
  context: ContentIdentity,
  input: unknown,
) {
  const args = ReferenceReadInputSchema.parse(input);
  const sql = getDatabase();
  const current = await readReferenceSelection(
    context,
    args.revisionId,
    sql,
    false,
  );
  if (
    !current.publication ||
    current.selection.sourceId !== args.sourceId ||
    current.selection.digest !== args.digest ||
    current.selection.checksum !== args.checksum
  )
    throw new ReferenceRuntimeError();
  const [document] = await sql<FullTextRow[]>`
    select d.id,d.xmin::text as version,d.full_text,d.full_text_locations,d.full_text_metadata,d.source_updated_at
    from allrice_knowledge_documents d where d.knowledge_revision_id=${args.revisionId}
      and d.organization_id=${current.organizationId} and d.workspace_id=${current.workspaceId}
      and d.source_ref=${'file:' + current.objectId} and d.checksum=${args.checksum} and d.active
      and d.full_text is not null and length(d.full_text)>0
      and d.full_text_locations is not null and d.full_text_metadata is not null`;
  if (!document) throw new ReferenceFullTextUnavailableError();
  const fullText = validateReferenceFullText({
    ...document.full_text_metadata,
    ...document.full_text_locations,
    text: document.full_text,
  });
  return {
    selection: current.selection,
    objectId: current.objectId,
    document,
    fullText,
  };
}
export type PreparedReferenceText = Awaited<
  ReturnType<typeof prepareReferenceText>
>;

function boundary(text: string, offset: number) {
  // R2 offsets are UTF-16. Never emit half of a surrogate pair.
  const code = text.charCodeAt(offset);
  return offset > 0 && code >= 0xdc00 && code <= 0xdfff ? offset - 1 : offset;
}

export function referenceTextPage(
  prepared: PreparedReferenceText,
  offset: number,
  limit: number,
) {
  const text = prepared.fullText.text;
  z.number().int().min(0).parse(offset);
  if (offset > text.length) throw new ReferenceReadOffsetError();
  ReferenceReadInputSchema.shape.limit.parse(limit);
  const start = boundary(text, offset);
  let end = boundary(text, Math.min(text.length, start + limit));
  // A one-code-unit request at a supplementary character cannot split it.
  if (end === start && start < text.length)
    end = Math.min(text.length, start + 2);
  const locations: ReferenceTextLocation[] = prepared.fullText.units.flatMap(
    (unit, index) =>
      unit.end > start && unit.start < end ? [{ ...unit, unit: index }] : [],
  );
  return {
    content: text.slice(start, end),
    start,
    end,
    nextOffset: end < text.length ? end : null,
    totalCharacters: text.length,
    locations,
    warnings: prepared.fullText.warnings,
  };
}

export function referenceTextCitation(
  prepared: PreparedReferenceText,
  page: ReturnType<typeof referenceTextPage>,
) {
  z.string().min(1).parse(page.content);
  const suffix = ` · v${prepared.selection.revision}`;
  let name = prepared.selection.fileName;
  if (name.length + suffix.length > 200)
    name = name.slice(0, boundary(name, 199 - suffix.length)) + '…';
  return KnowledgeRetrievalResultSchema.parse({
    content: page.content,
    citation: {
      type: 'knowledge',
      id: randomUUID(),
      label: name + suffix,
      knowledgeRevisionId: prepared.selection.revisionId,
      documentId: prepared.document.id,
      sourceKind: 'managed',
      scope: 'user',
      locator: {
        sourceRef: 'file:' + prepared.objectId,
        chunk: page.locations[0]?.unit ?? 0,
        start: page.start,
        end: page.end,
      },
      updatedAt: prepared.document.source_updated_at.toISOString(),
      score: 0,
      reference: prepared.selection,
    },
  });
}

/** Discovery's metadata pin becomes a byte-exact read pin; neither is authority. */
export function referenceReadPin(reference: ReferenceRevision) {
  if (!reference.manifestDigest) throw new ReferenceRuntimeError();
  return {
    sourceId: reference.sourceId,
    revisionId: reference.revisionId,
    digest: reference.manifestDigest,
    checksum: reference.checksum,
  };
}

export async function prepareReferenceSearch(
  context: ContentIdentity,
  input: unknown,
) {
  const args = ReferenceSearchInputSchema.parse(input);
  const { page, dependencies } = await preparePublicationQuery(
    context,
    args,
    false,
  );
  const excerpts = [];
  for (const reference of page.references) {
    if (!reference.fullTextReady) continue;
    const prepared = await prepareReferenceText(
      context,
      referenceReadPin(reference),
    );
    // Locate literal text, never classify user language. Matching a title or
    // purpose returns the start of the document with explicit offsets.
    const at = textMatchOffset(prepared.fullText.text, args.query);
    const text = referenceTextPage(
      prepared,
      Math.max(0, at),
      referenceSearchPolicy.excerptCharacters,
    );
    excerpts.push({
      prepared,
      page: text,
      result: referenceTextCitation(prepared, text),
    });
  }
  return { ...page, excerpts, dependencies };
}
