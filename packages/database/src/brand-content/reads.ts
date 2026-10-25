import { readBrandFeedbackBoard } from './feedback.ts';
import {
  BrandContentScopeSchema,
  BrandContentReadSchema,
  BrandContentBoardSchema,
  BrandContentBrandSchema,
  type RequestContext,
  type BrandContentBoard,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { employeeAccessTransaction } from '../employees/employee-access-cancellation.ts';
import {
  requireBrandContentScope,
  assertBrandContentFile,
} from './authority.ts';
import {
  readBrand,
  scopedRows,
  assertBrandBundle,
  readBrandContext,
} from './queries.ts';
import type { BrandContentMutationOptions } from './service.ts';
import { brandContentFail as fail } from './rules.ts';
import type {
  BrandRow,
  ContextRow,
  BatchRow,
  TopicRow,
  ArticleRow,
  BundleRow,
  ReviewRow,
  PlanRow,
  ReceiptRow,
} from './types.ts';

function mapBrand(row: BrandRow) {
  return BrandContentBrandSchema.parse({
    id: row.id,
    name: row.name,
    revision: row.revision,
    contextRevisionId: row.current_context_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}
export async function listBrandContentBrands(
  context: RequestContext,
  raw: unknown,
  options: BrandContentMutationOptions = {},
) {
  const input = BrandContentScopeSchema.parse(raw),
    db = options.db ?? getDatabase();
  return employeeAccessTransaction(db, async (tx) => {
    const scope = await requireBrandContentScope(
      tx,
      context,
      input,
      false,
      options.authority,
      false,
    );
    const rows = await tx<BrandRow[]>`select * from allrice_brand_content_brands
      where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and owner_id=${scope.ownerId} and instance_id=${scope.instanceId}
      order by updated_at desc,id desc limit 101`;
    if (options.authority === 'workflow' && !options.beforeCommit)
      fail('authority_denied');
    await options.beforeCommit?.(tx);
    return {
      brands: rows.slice(0, 100).map(mapBrand),
      truncated: rows.length > 100,
    };
  });
}
/** History is metadata over the same immutable native artifacts. Every read
 * rechecks the current principal and referenced files, not cached source text. */
export async function getBrandContentBoard(
  context: RequestContext,
  raw: unknown,
  options: BrandContentMutationOptions = {},
): Promise<BrandContentBoard> {
  const input = BrandContentReadSchema.parse(raw),
    db = options.db ?? getDatabase();
  // The board spans many statements. Without a commit fence (Worker tools pass
  // beforeCommit, which takes its own locks) they share one snapshot, so a
  // decision committing midway cannot pair an old batch with a new topic. Not
  // read only: a denied file read still records its audit row.
  const transaction = (
    run: Parameters<typeof employeeAccessTransaction<BrandContentBoard>>[1],
  ) =>
    employeeAccessTransaction(
      db,
      run,
      options.beforeCommit ? {} : { mode: 'isolation level repeatable read' },
    );
  return transaction(async (tx) => {
    const scope = await requireBrandContentScope(
      tx,
      context,
      input,
      false,
      options.authority,
      false,
    );
    const brand = await readBrand(tx, scope, input.brandId, false, false);
    const contexts = await scopedRows<ContextRow>(
      tx,
      scope,
      'contexts',
      brand.id,
    );
    const batches = await scopedRows<BatchRow>(tx, scope, 'batches', brand.id);
    const topics = await scopedRows<TopicRow>(tx, scope, 'topics', brand.id);
    const articles = await scopedRows<ArticleRow>(
      tx,
      scope,
      'articles',
      brand.id,
    );
    const bundles = await scopedRows<BundleRow>(tx, scope, 'bundles', brand.id);
    const reviews = await scopedRows<ReviewRow>(tx, scope, 'reviews', brand.id);
    const plans = await scopedRows<PlanRow>(tx, scope, 'plans', brand.id);
    const receipts = await scopedRows<ReceiptRow>(
      tx,
      scope,
      'receipts',
      brand.id,
    );
    const links = await tx<
      { batch_id: string; topic_id: string }[]
    >`select batch_id,topic_id from allrice_brand_content_batch_topics
      where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and owner_id=${scope.ownerId} and instance_id=${scope.instanceId} and brand_id=${brand.id}
        and batch_id in ${tx(batches.slice(0, 200).map((b) => b.id).length ? batches.slice(0, 200).map((b) => b.id) : ['00000000-0000-0000-0000-000000000000'])}`;
    for (const row of contexts.slice(0, 200))
      await readBrandContext(tx, context, scope, brand.id, row.id, false);
    // Fetch the referenced article even when the bounded article page omitted
    // it; the history page never bypasses source/instance checks at its edge.
    for (const bundle of bundles.slice(0, 200)) {
      const article =
        articles.find((a) => a.id === bundle.article_id) ??
        (
          await tx<
            ArticleRow[]
          >`select * from allrice_brand_content_articles where id=${bundle.article_id}
          and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
          and owner_id=${scope.ownerId} and instance_id=${scope.instanceId} and brand_id=${brand.id}`
        )[0];
      if (!article) fail('source_unavailable');
      await assertBrandBundle(
        tx,
        context,
        scope,
        brand.id,
        article,
        bundle,
        false,
      );
    }
    for (const receipt of receipts.slice(0, 200))
      for (const file of receipt.evidence_files)
        await assertBrandContentFile(tx, context, scope, file, false, false);
    const feedback = await readBrandFeedbackBoard(
      tx,
      context,
      scope,
      brand.id,
      false,
    );
    const board = BrandContentBoardSchema.parse({
      ...feedback,
      brand: mapBrand(brand),
      contexts: contexts.slice(0, 200).map((r) => ({
        id: r.id,
        brandName: r.brand_name,
        number: r.number,
        digest: r.digest,
        content: r.content,
        createdAt: r.created_at.toISOString(),
      })),
      batches: batches.slice(0, 200).map((r) => ({
        id: r.id,
        contextRevisionId: r.context_id,
        platform: r.platform,
        revision: r.revision,
        topicIds: links
          .filter((l) => l.batch_id === r.id)
          .map((l) => l.topic_id),
        workflow: r.workflow,
        createdAt: r.created_at.toISOString(),
      })),
      topics: topics.slice(0, 200).map((r) => ({
        id: r.id,
        contextRevisionId: r.context_id,
        platform: r.platform,
        candidate: r.candidate,
        state: r.state,
        revision: r.revision,
        decisionReason: r.decision_reason,
        createdAt: r.created_at.toISOString(),
      })),
      articles: articles.slice(0, 200).map((r) => ({
        id: r.id,
        topicId: r.topic_id,
        topicRevision: r.topic_revision,
        contextRevisionId: r.context_id,
        platform: r.platform,
        sessionId: r.session_id,
        revision: r.revision,
        state: r.state,
        currentBundleId: r.current_bundle_id,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      bundles: bundles.slice(0, 200).map((r) => ({
        id: r.id,
        articleId: r.article_id,
        number: r.number,
        content: r.content,
        images: r.images,
        digest: r.digest,
        parentBundleId: r.parent_bundle_id,
        sourceReviewId: r.source_review_id,
        changeSummary: r.change_summary,
        workflow: r.workflow,
        createdAt: r.created_at.toISOString(),
      })),
      reviews: reviews.slice(0, 200).map((r) => ({
        id: r.id,
        articleId: r.article_id,
        bundleId: r.bundle_id,
        bundleDigest: r.bundle_digest,
        decision: r.decision,
        reason: r.reason,
        decidedBy: r.decided_by,
        createdAt: r.created_at.toISOString(),
      })),
      plans: plans.slice(0, 200).map((r) => ({
        id: r.id,
        articleId: r.article_id,
        bundleId: r.bundle_id,
        bundleDigest: r.bundle_digest,
        reviewId: r.review_id,
        revision: r.revision,
        platform: r.platform,
        plannedAt: r.planned_at.toISOString(),
        timezone: r.timezone,
        publisher: r.publisher,
        notes: r.notes,
        state: r.state,
        reminderStatus: r.reminder_status,
        automationId: r.automation_id,
        automationRunId: r.automation_run_id,
        runId: r.run_id,
        reminderMessageId: r.reminder_message_id ?? null,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      receipts: receipts.slice(0, 200).map((r) => ({
        id: r.id,
        planId: r.plan_id,
        bundleDigest: r.bundle_digest,
        platform: r.platform,
        publisher: r.publisher,
        publishedUrl: r.published_url,
        actualPublishedAt: r.actual_published_at.toISOString(),
        sourceType: r.source_type,
        evidence: r.evidence,
        evidenceFiles: r.evidence_files,
        recordedBy: r.recorded_by,
        verificationState: 'provided',
        createdAt: r.created_at.toISOString(),
      })),
      truncated:
        [
          contexts,
          batches,
          topics,
          articles,
          bundles,
          reviews,
          plans,
          receipts,
        ].some((r) => r.length > 200) || feedback.truncated,
    });
    if (options.authority === 'workflow' && !options.beforeCommit)
      fail('authority_denied');
    await options.beforeCommit?.(tx);
    return board;
  });
}
