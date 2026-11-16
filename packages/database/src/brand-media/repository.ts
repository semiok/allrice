import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import {
  BrandMediaArticleSchema,
  BrandMediaImagesSchema,
  BrandMediaTopicSchema,
  transitionBrandMediaPublication,
  type BrandMediaArticle,
  type BrandMediaMutationResult,
  type BrandMediaReadInput,
  type BrandMediaReadResult,
  type BrandMediaTopic,
  type BrandMediaUserCommand,
} from '@allrice/contracts';
import { brandMediaFail as fail } from './errors.ts';

// Business ownership stops at these two tables. Core identity, references,
// deliverables, idempotency and audit are only reached through server-wiring.
export type BrandMediaScope = {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  instanceId: string;
};
type Tx = postgres.TransactionSql;
type TopicRow = {
  id: string;
  workspace_id: string;
  instance_id: string;
  revision: number;
  candidate: BrandMediaTopic['candidate'];
  direction: string;
  reference_pins: BrandMediaTopic['references'];
  source_run_id: string;
  created_at_iso: string;
  updated_at: Date;
};
type ArticleRow = Omit<
  TopicRow,
  'candidate' | 'direction' | 'source_run_id'
> & {
  topic_id: string;
  title: string;
  requirements: string;
  body_file: BrandMediaArticle['body'];
  images: BrandMediaArticle['images'];
  state: 'draft' | 'scheduled' | 'published';
  planned_at: Date | null;
  planned_at_iso: string | null;
  timezone: string | null;
  wechat_url: string | null;
  xiaohongshu_url: string | null;
};
const record = (row: TopicRow | ArticleRow) => ({
  id: row.id,
  workspaceId: row.workspace_id,
  instanceId: row.instance_id,
  revision: row.revision,
  // Preserve PG microseconds for the public (createdAt,id) cursor. A JS Date
  // alone truncates precision and skips records on the next page.
  createdAt: row.created_at_iso,
  updatedAt: row.updated_at.toISOString(),
});
const topicDto = (row: TopicRow) =>
  BrandMediaTopicSchema.parse({
    ...record(row),
    candidate: row.candidate,
    direction: row.direction,
    references: row.reference_pins,
    sourceRunId: row.source_run_id,
  });
const articleDto = (row: ArticleRow) =>
  BrandMediaArticleSchema.parse({
    ...record(row),
    topicId: row.topic_id,
    title: row.title,
    requirements: row.requirements,
    body: row.body_file,
    references: row.reference_pins,
    images: row.images,
    publication: {
      state: row.state,
      schedule:
        row.state === 'draft'
          ? null
          : { plannedAt: row.planned_at_iso!, timezone: row.timezone },
      links:
        row.state === 'published'
          ? { wechat: row.wechat_url, xiaohongshu: row.xiaohongshu_url }
          : null,
    },
  });
const scopeWhere = (tx: Tx, scope: BrandMediaScope) => tx`
  organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
  and owner_id=${scope.ownerId} and instance_id=${scope.instanceId}`;
const createdAt = (tx: Tx) => tx`
  to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_iso`;
const articleTimes = (tx: Tx) => tx`${createdAt(tx)},
  to_char(planned_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as planned_at_iso`;
async function readTopic(tx: Tx, scope: BrandMediaScope, id: string) {
  const [row] = await tx<
    TopicRow[]
  >`select *,${createdAt(tx)} from allrice_brand_media_topics
    where ${scopeWhere(tx, scope)} and id=${id} for update`;
  if (!row) fail('not_found');
  return topicDto(row);
}
async function readArticle(
  tx: Tx,
  scope: BrandMediaScope,
  id: string,
  lock: boolean,
) {
  const [row] = await tx<
    ArticleRow[]
  >`select *,${articleTimes(tx)} from allrice_brand_media_articles
    where ${scopeWhere(tx, scope)} and id=${id} ${lock ? tx`for update` : tx``}`;
  if (!row) fail('not_found');
  return articleDto(row);
}
const assertRevision = (actual: number, expected: number) => {
  if (actual !== expected) fail('version_conflict');
};
const pageSize = 100;
export async function readBrandMediaRecords(
  tx: Tx,
  scope: BrandMediaScope,
  input: BrandMediaReadInput,
): Promise<BrandMediaReadResult> {
  if (input.view === 'article')
    return {
      view: 'article',
      article: await readArticle(tx, scope, input.articleId, false),
    };
  if (input.view === 'calendar') {
    // PostgreSQL resolves both local midnights independently across DST. No
    // list cap or client-side filtering can drop the 202nd article of a month.
    const rows = await tx<
      ArticleRow[]
    >`select *,${articleTimes(tx)} from allrice_brand_media_articles
      where ${scopeWhere(tx, scope)} and state in ('scheduled','published')
        and planned_at >= (${input.month + '-01'}::timestamp at time zone ${input.timezone})
        and planned_at < ((${input.month + '-01'}::timestamp + interval '1 month') at time zone ${input.timezone})
      order by planned_at,id`;
    return { view: 'calendar', items: rows.map(articleDto) };
  }
  // Bind as text before the PG timestamp cast: postgres.js otherwise selects
  // its Date serializer for timestamptz parameters and truncates microseconds.
  const cursor = input.cursor
    ? tx`and (created_at,id)<(${input.cursor.createdAt}::text::timestamptz,${input.cursor.id}::uuid)`
    : tx``;
  if (input.view === 'topics') {
    const rows = await tx<
      TopicRow[]
    >`select *,${createdAt(tx)} from allrice_brand_media_topics
      where ${scopeWhere(tx, scope)} ${cursor}
        and not exists(select 1 from allrice_brand_media_articles a where a.topic_id=allrice_brand_media_topics.id)
      order by created_at desc,id desc limit ${pageSize + 1}`;
    const items = rows.slice(0, pageSize).map(topicDto),
      last = items.at(-1);
    return {
      view: 'topics',
      items,
      nextCursor:
        rows.length > pageSize && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }
  const rows = await tx<
    ArticleRow[]
  >`select *,${articleTimes(tx)} from allrice_brand_media_articles
    where ${scopeWhere(tx, scope)} ${cursor} ${input.state ? tx`and state=${input.state}` : tx``}
    order by created_at desc,id desc limit ${pageSize + 1}`;
  const items = rows.slice(0, pageSize).map(articleDto),
    last = items.at(-1);
  return {
    view: 'articles',
    items,
    nextCursor:
      rows.length > pageSize && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}
export async function applyBrandMediaUserCommand(
  tx: Tx,
  scope: BrandMediaScope,
  action: BrandMediaUserCommand,
): Promise<BrandMediaMutationResult> {
  if (action.operation === 'topic.add') {
    const id = randomUUID();
    await tx`insert into allrice_brand_media_topics
      (id,organization_id,workspace_id,owner_id,instance_id,candidate,direction,reference_pins,source_run_id)
      values(${id},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},
        ${tx.json(action.candidate)},${action.direction},${tx.json(action.references)},${action.sourceRunId})`;
    return { kind: 'topic', topic: await readTopic(tx, scope, id) };
  }
  if (
    action.operation === 'topic.delete' ||
    action.operation === 'article.start'
  ) {
    const topic = await readTopic(tx, scope, action.topicId);
    assertRevision(topic.revision, action.expectedRevision);
    const [used] = await tx`select id from allrice_brand_media_articles
      where ${scopeWhere(tx, scope)} and topic_id=${topic.id}`;
    if (used) fail('invalid_state');
    if (action.operation === 'topic.delete') {
      const removed = await tx`delete from allrice_brand_media_topics
        where ${scopeWhere(tx, scope)} and id=${topic.id} and revision=${action.expectedRevision}`;
      if (removed.count !== 1) fail('version_conflict');
      return { kind: 'deleted', id: topic.id };
    }
    const id = randomUUID();
    await tx`insert into allrice_brand_media_articles
      (id,organization_id,workspace_id,owner_id,instance_id,topic_id,title,requirements,reference_pins)
      values(${id},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},
        ${topic.id},${topic.candidate.title},${action.requirements},${tx.json(action.references)})`;
    return { kind: 'article', article: await readArticle(tx, scope, id, true) };
  }
  const article = await readArticle(tx, scope, action.articleId, true);
  assertRevision(article.revision, action.expectedRevision);
  if (
    article.publication.state === 'published' &&
    !(
      action.operation === 'article.publication' &&
      action.change.action === 'unpublish'
    )
  )
    fail('invalid_state');
  if (action.operation === 'article.delete') {
    const topic = await readTopic(tx, scope, article.topicId);
    const removed = await tx`delete from allrice_brand_media_articles
      where ${scopeWhere(tx, scope)} and id=${article.id} and revision=${action.expectedRevision}`;
    if (removed.count !== 1) fail('version_conflict');
    const removedTopic = await tx`delete from allrice_brand_media_topics
      where ${scopeWhere(tx, scope)} and id=${topic.id} and revision=${topic.revision}`;
    if (removedTopic.count !== 1) fail('version_conflict');
    return { kind: 'deleted', id: article.id };
  }
  let publication = article.publication,
    references = article.references,
    images = article.images;
  if (action.operation === 'article.publication') {
    try {
      publication = transitionBrandMediaPublication(publication, action.change);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'brand_media_invalid_transition'
      )
        fail('invalid_state');
      throw error;
    }
  } else if (action.operation === 'article.references')
    references = action.references;
  else if (action.operation === 'article.image.add')
    images = BrandMediaImagesSchema.parse([...images, action.image]);
  else {
    if (!images.some((image) => image.file.versionId === action.versionId))
      fail('source_reference_invalid');
    images = images.filter(
      (image) => image.file.versionId !== action.versionId,
    );
  }
  // The same text cast preserves an existing schedule on publish/correction.
  const updated = await tx`update allrice_brand_media_articles set
    reference_pins=${tx.json(references)},images=${tx.json(images)},state=${publication.state},
    planned_at=${publication.schedule?.plannedAt ?? null}::text::timestamptz,timezone=${publication.schedule?.timezone ?? null},
    wechat_url=${publication.links?.wechat ?? null},xiaohongshu_url=${publication.links?.xiaohongshu ?? null},
    revision=revision+1,updated_at=clock_timestamp()
    where ${scopeWhere(tx, scope)} and id=${article.id} and revision=${action.expectedRevision}`;
  if (updated.count !== 1) fail('version_conflict');
  return {
    kind: 'article',
    article: await readArticle(tx, scope, article.id, true),
  };
}
