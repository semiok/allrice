import { randomUUID } from 'node:crypto';
import {
  BrandContentActionSchema,
  BrandContentMutationReceiptSchema,
  type BrandContentAction,
  type BrandContentMutationReceipt,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { employeeAccessTransaction } from '../employees/employee-access-cancellation.ts';
import { invalidateBrandContentReminder } from './reminder-invalidation.ts';
import {
  assertBrandContentAuthority,
  assertBrandContentParent,
  assertBrandContentApprovedBundle,
  assertBrandRevision,
  brandContentBundleDigest,
  brandContentDigest,
  brandContentFail as fail,
  mergeBrandContentImages,
  normalizeBrandTopicTitle,
} from './rules.ts';
import {
  requireBrandContentScope,
  assertBrandContentDocument,
  assertBrandContentImages,
  assertBrandContentFile,
  assertBrandContentSession,
} from './authority.ts';
import {
  readBrand,
  readBrandContext,
  scopedRow,
  assertBrandBundle,
} from './queries.ts';
import type {
  Scope,
  Tx,
  BrandContentDatabase,
  BrandContentAuthority,
  BrandRow,
  BatchRow,
  TopicRow,
  ArticleRow,
  BundleRow,
  ReviewRow,
  PlanRow,
  BrandContentIdentity,
} from './types.ts';

export { BrandContentError } from './rules.ts';
export type { BrandContentAuthority } from './types.ts';
export type BrandContentMutationOptions = {
  authority?: BrandContentAuthority;
  db?: BrandContentDatabase;
  /** Server-only admission fence; must use this transaction and no network. */
  beforeCommit?: (tx: Tx) => Promise<void>;
};
export type BrandContentTransactionOptions = Pick<
  BrandContentMutationOptions,
  'authority' | 'beforeCommit'
>;
type Result = BrandContentMutationReceipt['result'];
const result = (
  brandId: string,
  entityId: string,
  revision: number,
  state: string,
  extra: Partial<Result> = {},
): Result => ({ brandId, entityId, revision, state, ...extra });

async function insertBundle(
  tx: Tx,
  scope: Scope,
  brandId: string,
  articleId: string,
  id: string,
  value: {
    number: number;
    content: BundleRow['content'];
    images: BundleRow['images'];
    digest: string;
    parentBundleId: string | null;
    sourceReviewId: string | null;
    changeSummary: string;
    workflow: BundleRow['workflow'];
  },
) {
  await tx`insert into allrice_brand_content_bundles
    (id,organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,number,content,images,digest,parent_bundle_id,source_review_id,change_summary,workflow)
    values(${id},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${articleId},${value.number},
      ${tx.json(value.content)},${tx.json(value.images)},${value.digest},${value.parentBundleId},${value.sourceReviewId},${value.changeSummary},${value.workflow ? tx.json(value.workflow) : null})`;
}
async function latestRejection(
  tx: Tx,
  scope: Scope,
  brandId: string,
  article: ArticleRow,
) {
  if (article.state !== 'changes_requested') return null;
  const [review] = await tx<
    { id: string }[]
  >`select id from allrice_brand_content_reviews
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
      and instance_id=${scope.instanceId} and brand_id=${brandId} and article_id=${article.id}
      and bundle_id=${article.current_bundle_id} and decision='rejected'`;
  if (!review) fail('invalid_state');
  return review.id;
}
async function ensurePlanUnpublished(tx: Tx, scope: Scope, plan: PlanRow) {
  const [receipt] =
    await tx`select id from allrice_brand_content_receipts where plan_id=${plan.id}
    and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
    and owner_id=${scope.ownerId} and instance_id=${scope.instanceId}`;
  if (receipt || plan.state !== 'planned') fail('invalid_state');
}
async function assertReminderMessageReceipt(
  tx: Tx,
  scope: Scope,
  plan: PlanRow,
  action: Extract<BrandContentAction, { operation: 'plan.reminder' }>,
) {
  const [receipt] = await tx<
    { content: unknown; delivery_content_digest: string }[]
  >`
    select m.content,d.delivery_content_digest from allrice_brand_content_reminders d
    join allrice_automations a on a.id=d.automation_id and a.brand_content_binding=d.id
    join allrice_automation_runs o on o.id=d.automation_run_id and o.automation_id=a.id
      and o.organization_id=d.organization_id and o.workspace_id=d.workspace_id and o.session_id=d.session_id
    join allrice_messages m on m.id=d.delivery_message_id and m.session_id=d.session_id
      and m.organization_id=d.organization_id and m.workspace_id=d.workspace_id and m.owner_id=d.owner_id
    join allrice_chat_sessions s on s.id=d.session_id and s.owner_id=d.owner_id
      and s.employee_assignment_id=d.assignment_id and s.employee_instance_id=d.instance_id
    where d.plan_id=${plan.id} and d.organization_id=${scope.organizationId} and d.workspace_id=${scope.workspaceId}
      and d.owner_id=${scope.ownerId} and d.instance_id=${scope.instanceId} and d.brand_id=${action.brandId}
      and d.bundle_id=${plan.bundle_id} and d.review_id=${plan.review_id} and d.bundle_digest=${plan.bundle_digest}
      and d.plan_revision=${action.expectedRevision} and d.state='reminded'
      and d.automation_id=${action.automationId} and d.automation_run_id=${action.automationRunId!}
      and d.delivery_message_id=${action.deliveryMessageId!} and m.id=d.reserved_message_id and m.client_message_id=m.id
      and o.id=d.reserved_occurrence_id and o.status='succeeded' and o.run_id is null
      and m.role='assistant' and m.status='completed' and m.completed_at is not null and m.visibility='private'
      and s.visibility='private' and s.archived_at is null for share of d,o,m,s`;
  if (
    !receipt ||
    brandContentDigest(receipt.content) !== receipt.delivery_content_digest
  )
    fail('reminder_unconfirmed');
}
async function applyAction(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  action: BrandContentAction,
  brand: BrandRow | null,
): Promise<Result> {
  if (action.operation === 'context.save') {
    const brandId = brand?.id ?? randomUUID(),
      contextId = randomUUID();
    assertBrandRevision(brand?.revision ?? 0, action.expectedRevision);
    for (const file of action.content.sourceFiles)
      await assertBrandContentFile(tx, context, scope, file);
    const next = (brand?.revision ?? 0) + 1;
    if (!brand)
      await tx`insert into allrice_brand_content_brands
      (id,organization_id,workspace_id,owner_id,instance_id,name,revision,current_context_id)
      values(${brandId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${action.name},${next},${contextId})`;
    await tx`insert into allrice_brand_content_contexts
      (id,organization_id,workspace_id,owner_id,instance_id,brand_id,number,brand_name,content,digest)
      values(${contextId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${next},${action.name},
        ${tx.json(action.content)},${brandContentDigest({ name: action.name, content: action.content })})`;
    if (brand)
      await tx`update allrice_brand_content_brands set name=${action.name},revision=${next},
      current_context_id=${contextId},updated_at=clock_timestamp() where id=${brandId}`;
    return result(brandId, brandId, next, 'context_saved', {
      contextRevisionId: contextId,
    });
  }
  if (!brand) fail('not_found');
  const brandId = brand.id;
  if (action.operation === 'topics.propose') {
    const frozen = await readBrandContext(
      tx,
      context,
      scope,
      brandId,
      action.contextRevisionId,
    );
    const batchId = randomUUID(),
      ids: string[] = [],
      duplicates: string[] = [];
    const knownFacts = new Set(frozen.content.facts.map((f) => f.id));
    await tx`insert into allrice_brand_content_batches
      (id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,platform,workflow)
      values(${batchId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${frozen.id},${action.platform},${action.workflow ? tx.json(action.workflow) : null})`;
    for (const candidate of action.candidates) {
      if (candidate.factIds.some((f) => !knownFacts.has(f)))
        fail('source_reference_invalid');
      const titleKey = normalizeBrandTopicTitle(candidate.title);
      const [old] = await tx<
        { id: string }[]
      >`select id from allrice_brand_content_topics
        where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
          and instance_id=${scope.instanceId} and brand_id=${brandId} and context_id=${frozen.id}
          and platform=${action.platform} and title_key=${titleKey}`;
      const id = old?.id ?? randomUUID();
      if (!old)
        await tx`insert into allrice_brand_content_topics
        (id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,platform,title_key,candidate)
        values(${id},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${frozen.id},${action.platform},${titleKey},${tx.json(candidate)})`;
      else if (!duplicates.includes(id)) duplicates.push(id);
      if (!ids.includes(id)) {
        ids.push(id);
        await tx`insert into allrice_brand_content_batch_topics
          (organization_id,workspace_id,owner_id,instance_id,brand_id,batch_id,topic_id)
          values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${batchId},${id})`;
      }
    }
    return result(brandId, batchId, 1, 'candidates_saved', {
      contextRevisionId: frozen.id,
      topicIds: ids,
      duplicateTopicIds: duplicates,
    });
  }
  if (action.operation === 'topics.decide') {
    const batch = await scopedRow<BatchRow>(
      tx,
      scope,
      'batches',
      brandId,
      action.batchId,
    );
    assertBrandRevision(batch.revision, action.expectedRevision);
    await readBrandContext(tx, context, scope, brandId, batch.context_id);
    for (const choice of action.choices) {
      const [linked] =
        await tx`select topic_id from allrice_brand_content_batch_topics
        where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
          and instance_id=${scope.instanceId} and brand_id=${brandId} and batch_id=${batch.id} and topic_id=${choice.topicId}`;
      if (!linked) fail('not_found');
      const topic = await scopedRow<TopicRow>(
        tx,
        scope,
        'topics',
        brandId,
        choice.topicId,
      );
      const [article] =
        await tx`select id from allrice_brand_content_articles where topic_id=${topic.id}`;
      if (article) fail('invalid_state');
      await tx`update allrice_brand_content_topics set state=${choice.decision},decision_reason=${choice.reason},revision=revision+1 where id=${topic.id}`;
    }
    // Deduplicated topics may appear in more than one batch. Invalidate every
    // affected selection view once, so another batch cannot submit stale state.
    await tx`update allrice_brand_content_batches set revision=revision+1
      where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
        and instance_id=${scope.instanceId} and brand_id=${brandId} and id in (
          select batch_id from allrice_brand_content_batch_topics where organization_id=${scope.organizationId}
            and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and instance_id=${scope.instanceId}
            and brand_id=${brandId} and topic_id in ${tx(action.choices.map((c) => c.topicId))})`;
    return result(brandId, batch.id, batch.revision + 1, 'topics_decided', {
      contextRevisionId: batch.context_id,
      topicIds: action.choices.map((c) => c.topicId),
    });
  }
  if (action.operation === 'article.submit') {
    const topic = await scopedRow<TopicRow>(
      tx,
      scope,
      'topics',
      brandId,
      action.topicId,
    );
    if (topic.state !== 'accepted') fail('invalid_state');
    await readBrandContext(tx, context, scope, brandId, topic.context_id);
    await assertBrandContentSession(tx, context, scope, action.sessionId, true);
    const document = await assertBrandContentDocument(
      tx,
      context,
      scope,
      action.sessionId,
      action.content,
      true,
    );
    await assertBrandContentImages(tx, context, scope, action.images);
    let article: ArticleRow | null = null,
      old: BundleRow | null = null;
    if (action.articleId) {
      article = await scopedRow<ArticleRow>(
        tx,
        scope,
        'articles',
        brandId,
        action.articleId,
      );
      assertBrandRevision(article.revision, action.expectedRevision);
      if (
        article.topic_id !== topic.id ||
        article.session_id !== action.sessionId
      )
        fail('source_reference_invalid');
      old = await scopedRow<BundleRow>(
        tx,
        scope,
        'bundles',
        brandId,
        article.current_bundle_id,
      );
      assertBrandContentParent(old.content.versionId, action.parentVersionId, {
        versionId: action.content.versionId,
        parentVersionId: document.version.parentVersionId,
      });
    } else {
      assertBrandRevision(0, action.expectedRevision);
      if (action.parentVersionId || action.reviewId) fail('parent_mismatch');
      const [existing] =
        await tx`select id from allrice_brand_content_articles where topic_id=${topic.id}`;
      if (existing) fail('version_conflict');
    }
    const sourceReviewId = article
      ? await latestRejection(tx, scope, brandId, article)
      : null;
    if (action.reviewId && action.reviewId !== sourceReviewId)
      fail('source_reference_invalid');
    const articleId = article?.id ?? randomUUID(),
      bundleId = randomUUID(),
      next = (article?.revision ?? 0) + 1;
    const digest = brandContentBundleDigest(
      topic.platform,
      action.content,
      action.images,
    );
    if (!article)
      await tx`insert into allrice_brand_content_articles
      (id,organization_id,workspace_id,owner_id,instance_id,brand_id,topic_id,topic_revision,context_id,session_id,platform,state,current_bundle_id)
      values(${articleId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${topic.id},${topic.revision},${topic.context_id},${action.sessionId},${topic.platform},'awaiting_review',${bundleId})`;
    await insertBundle(tx, scope, brandId, articleId, bundleId, {
      number: (old?.number ?? 0) + 1,
      content: action.content,
      images: action.images,
      digest,
      parentBundleId: old?.id ?? null,
      sourceReviewId,
      changeSummary: action.changeSummary,
      workflow: action.workflow ?? null,
    });
    if (article)
      await tx`update allrice_brand_content_articles set current_bundle_id=${bundleId},revision=${next},state='awaiting_review',updated_at=clock_timestamp() where id=${article.id}`;
    return result(brandId, articleId, next, 'awaiting_review', {
      bundleDigest: digest,
      contextRevisionId: topic.context_id,
    });
  }
  if (
    action.operation === 'article.images' ||
    action.operation === 'article.review'
  ) {
    const article = await scopedRow<ArticleRow>(
      tx,
      scope,
      'articles',
      brandId,
      action.articleId,
    );
    assertBrandRevision(article.revision, action.expectedRevision);
    const bundle = await scopedRow<BundleRow>(
      tx,
      scope,
      'bundles',
      brandId,
      article.current_bundle_id,
    );
    if (bundle.digest !== action.bundleDigest) fail('version_conflict');
    await assertBrandBundle(tx, context, scope, brandId, article, bundle);
    const next = article.revision + 1;
    if (action.operation === 'article.images') {
      const images = mergeBrandContentImages(
        bundle.images,
        action.images,
        action.removeSlots,
      );
      await assertBrandContentImages(tx, context, scope, images);
      const digest = brandContentBundleDigest(
        article.platform,
        bundle.content,
        images,
      );
      if (digest === bundle.digest) fail('invalid_state');
      const id = randomUUID(),
        sourceReviewId = await latestRejection(tx, scope, brandId, article);
      await insertBundle(tx, scope, brandId, article.id, id, {
        number: bundle.number + 1,
        content: bundle.content,
        images,
        digest,
        parentBundleId: bundle.id,
        sourceReviewId,
        changeSummary: action.changeSummary,
        workflow: action.workflow ?? null,
      });
      await tx`update allrice_brand_content_articles set current_bundle_id=${id},revision=${next},state='awaiting_review',updated_at=clock_timestamp() where id=${article.id}`;
      return result(brandId, article.id, next, 'awaiting_review', {
        bundleDigest: digest,
      });
    }
    if (article.state !== 'awaiting_review') fail('invalid_state');
    const reviewId = randomUUID(),
      state = action.decision === 'approved' ? 'approved' : 'changes_requested';
    await tx`insert into allrice_brand_content_reviews
      (id,organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,bundle_id,bundle_digest,decision,reason,decided_by)
      values(${reviewId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${article.id},${bundle.id},${bundle.digest},${action.decision},${action.reason},${scope.ownerId})`;
    await tx`update allrice_brand_content_articles set revision=${next},state=${state},updated_at=clock_timestamp() where id=${article.id}`;
    return result(brandId, article.id, next, state, {
      bundleDigest: bundle.digest,
      reviewId,
    });
  }
  if (action.operation === 'plan.save') {
    const article = await scopedRow<ArticleRow>(
      tx,
      scope,
      'articles',
      brandId,
      action.articleId,
    );
    const bundle = await scopedRow<BundleRow>(
      tx,
      scope,
      'bundles',
      brandId,
      article.current_bundle_id,
    );
    const review = await scopedRow<ReviewRow>(
      tx,
      scope,
      'reviews',
      brandId,
      action.reviewId,
    );
    assertBrandContentApprovedBundle(article, bundle, review, action);
    if (Date.parse(action.plannedAt) <= Date.now()) fail('invalid_state');
    await assertBrandBundle(tx, context, scope, brandId, article, bundle);
    let plan: PlanRow | null = null;
    if (action.planId) {
      plan = await scopedRow<PlanRow>(
        tx,
        scope,
        'plans',
        brandId,
        action.planId,
      );
      assertBrandRevision(plan.revision, action.expectedRevision);
      if (plan.article_id !== article.id) fail('source_reference_invalid');
      await ensurePlanUnpublished(tx, scope, plan);
    } else {
      assertBrandRevision(0, action.expectedRevision);
      const [active] =
        await tx`select id from allrice_brand_content_plans where article_id=${article.id} and platform=${action.platform} and state='planned'`;
      if (active) fail('version_conflict');
    }
    const planId = plan?.id ?? randomUUID(),
      next = (plan?.revision ?? 0) + 1;
    if (!plan)
      await tx`insert into allrice_brand_content_plans
      (id,organization_id,workspace_id,owner_id,instance_id,brand_id,article_id,bundle_id,review_id,bundle_digest,platform,planned_at,timezone,publisher,notes)
      values(${planId},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${article.id},${bundle.id},${review.id},${bundle.digest},${action.platform},${new Date(action.plannedAt)},${action.timezone},${action.publisher},${action.notes})`;
    else {
      await invalidateBrandContentReminder(tx, plan!, 'PLAN_CHANGED');
      await tx`update allrice_brand_content_plans set bundle_id=${bundle.id},review_id=${review.id},bundle_digest=${bundle.digest},
      planned_at=${new Date(action.plannedAt)},timezone=${action.timezone},publisher=${action.publisher},notes=${action.notes},revision=${next},
      reminder_status='not_registered',automation_id=null,automation_run_id=null,run_id=null,reminder_message_id=null,updated_at=clock_timestamp() where id=${planId}`;
    }
    return result(brandId, planId, next, 'planned', {
      bundleDigest: bundle.digest,
      reminderStatus: 'not_registered',
    });
  }
  const plan = await scopedRow<PlanRow>(
    tx,
    scope,
    'plans',
    brandId,
    action.planId,
  );
  assertBrandRevision(plan.revision, action.expectedRevision);
  await ensurePlanUnpublished(tx, scope, plan);
  if (action.operation === 'plan.cancel') {
    await invalidateBrandContentReminder(tx, plan, 'PLAN_CANCELLED');
    const reminderStatus =
      plan.reminder_status === 'registered'
        ? 'not_registered'
        : plan.reminder_status;
    await tx`update allrice_brand_content_plans set state='cancelled',cancellation_reason=${action.reason},reminder_status=${reminderStatus},revision=revision+1,updated_at=clock_timestamp() where id=${plan.id}`;
    return result(brandId, plan.id, plan.revision + 1, 'cancelled', {
      reminderStatus,
    });
  }
  const article = await scopedRow<ArticleRow>(
    tx,
    scope,
    'articles',
    brandId,
    plan.article_id,
  );
  const bundle = await scopedRow<BundleRow>(
    tx,
    scope,
    'bundles',
    brandId,
    plan.bundle_id,
  );
  await assertBrandBundle(tx, context, scope, brandId, article, bundle);
  if (action.operation === 'plan.reminder') {
    const [automation] = await tx<
      { id: string; status: string; brand_content_binding: string | null }[]
    >`select a.id,a.status,a.brand_content_binding from allrice_automations a
      join allrice_employee_instances i on i.assignment_id=a.employee_assignment_id
      where a.id=${action.automationId} and a.organization_id=${scope.organizationId} and a.workspace_id=${scope.workspaceId}
        and a.owner_id=${scope.ownerId} and i.id=${scope.instanceId} and i.owner_id=${scope.ownerId}
        and a.trigger_type='schedule' and a.schedule->>'frequency'='once' for share of a`;
    if (
      !automation ||
      (plan.automation_id && plan.automation_id !== action.automationId)
    )
      fail('reminder_unconfirmed');
    if (action.status === 'registered') {
      if (
        plan.reminder_status !== 'not_registered' ||
        automation.status !== 'enabled'
      )
        fail('invalid_state');
      if (automation.brand_content_binding) {
        const [binding] =
          await tx`select id from allrice_brand_content_reminders
          where id=${automation.brand_content_binding} and automation_id=${action.automationId} and plan_id=${plan.id}
            and plan_revision=${plan.revision + 1} and owner_id=${scope.ownerId} and instance_id=${scope.instanceId}
            and bundle_id=${plan.bundle_id} and review_id=${plan.review_id} and bundle_digest=${plan.bundle_digest} and state='registered'`;
        if (!binding) fail('reminder_unconfirmed');
      }
    } else {
      if (
        plan.automation_id !== action.automationId ||
        !['registered', 'unknown'].includes(plan.reminder_status)
      )
        fail('invalid_state');
      if (
        plan.reminder_status === 'unknown' &&
        (plan.automation_run_id !== action.automationRunId ||
          plan.run_id !== action.runId)
      )
        fail('reminder_unconfirmed');
      if (action.deliveryMessageId) {
        if (!automation.brand_content_binding) fail('reminder_unconfirmed');
        await assertReminderMessageReceipt(tx, scope, plan, action);
      } else {
        if (automation.brand_content_binding) fail('reminder_unconfirmed');
        const [occurrence] = await tx<
          { status: string; state: string }[]
        >`select o.status,r.state
        from allrice_automation_runs o join allrice_runs r on r.id=o.run_id and r.organization_id=o.organization_id and r.workspace_id=o.workspace_id
        where o.id=${action.automationRunId!} and o.automation_id=${action.automationId} and o.run_id=${action.runId!}
          and o.organization_id=${scope.organizationId} and o.workspace_id=${scope.workspaceId} and r.owner_id=${scope.ownerId} for share of o,r`;
        if (
          !occurrence ||
          (action.status === 'reminded' &&
            (occurrence.status !== 'succeeded' ||
              occurrence.state !== 'succeeded')) ||
          (action.status === 'failed' &&
            !['failed', 'canceled'].includes(occurrence.status)) ||
          (action.status === 'unknown' &&
            ['succeeded', 'failed', 'canceled'].includes(occurrence.status))
        )
          fail('reminder_unconfirmed');
      }
    }
    await tx`update allrice_brand_content_plans set reminder_status=${action.status},automation_id=${action.automationId},
      automation_run_id=${action.automationRunId ?? null},run_id=${action.runId ?? null},reminder_message_id=${action.deliveryMessageId ?? null},revision=revision+1,updated_at=clock_timestamp() where id=${plan.id}`;
    return result(brandId, plan.id, plan.revision + 1, 'planned', {
      reminderStatus: action.status,
      bundleDigest: plan.bundle_digest,
    });
  }
  if (action.operation !== 'receipt.record') fail('invalid_state');
  if (
    action.bundleDigest !== plan.bundle_digest ||
    action.platform !== plan.platform ||
    Date.parse(action.actualPublishedAt) > Date.now()
  )
    fail('receipt_invalid');
  for (const file of action.evidenceFiles)
    await assertBrandContentFile(tx, context, scope, file);
  const id = randomUUID();
  await tx`insert into allrice_brand_content_receipts
    (id,organization_id,workspace_id,owner_id,instance_id,brand_id,plan_id,bundle_digest,platform,publisher,published_url,actual_published_at,source_type,evidence,evidence_files,recorded_by)
    values(${id},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${plan.id},${plan.bundle_digest},${action.platform},${action.publisher},${action.publishedUrl},${new Date(action.actualPublishedAt)},${action.sourceType},${action.evidence},${tx.json(action.evidenceFiles)},${scope.ownerId})`;
  await tx`update allrice_brand_content_plans set revision=revision+1,updated_at=clock_timestamp() where id=${plan.id}`;
  return result(brandId, id, plan.revision + 1, 'receipt_recorded', {
    bundleDigest: plan.bundle_digest,
  });
}

async function recheckReceipt(
  tx: Tx,
  context: BrandContentIdentity,
  scope: Scope,
  action: BrandContentAction,
  response: BrandContentMutationReceipt,
) {
  const brandId = response.result.brandId;
  await readBrand(tx, scope, brandId);
  if (response.result.contextRevisionId)
    await readBrandContext(
      tx,
      context,
      scope,
      brandId,
      response.result.contextRevisionId,
    );
  if (action.operation.startsWith('article.')) {
    const article = await scopedRow<ArticleRow>(
      tx,
      scope,
      'articles',
      brandId,
      response.result.entityId,
    );
    const [bundle] = await tx<
      BundleRow[]
    >`select * from allrice_brand_content_bundles
      where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId}
        and instance_id=${scope.instanceId} and brand_id=${brandId} and article_id=${article.id} and digest=${response.result.bundleDigest ?? ''}`;
    if (!bundle) fail('source_unavailable');
    await assertBrandBundle(tx, context, scope, brandId, article, bundle);
  }
  if (
    action.operation === 'plan.save' ||
    action.operation === 'plan.reminder' ||
    action.operation === 'receipt.record'
  ) {
    const planId =
      action.operation === 'receipt.record'
        ? action.planId
        : response.result.entityId;
    const plan = await scopedRow<PlanRow>(tx, scope, 'plans', brandId, planId);
    const article = await scopedRow<ArticleRow>(
      tx,
      scope,
      'articles',
      brandId,
      plan.article_id,
    );
    const bundle = await scopedRow<BundleRow>(
      tx,
      scope,
      'bundles',
      brandId,
      plan.bundle_id,
    );
    await assertBrandBundle(tx, context, scope, brandId, article, bundle);
    if (action.operation === 'plan.reminder' && action.deliveryMessageId)
      await assertReminderMessageReceipt(tx, scope, plan, action);
  }
  if (action.operation === 'receipt.record')
    for (const file of action.evidenceFiles)
      await assertBrandContentFile(tx, context, scope, file);
}

function prepareMutation(
  raw: unknown,
  options: BrandContentTransactionOptions,
) {
  const action = BrandContentActionSchema.parse(raw),
    authority = options.authority ?? 'user';
  assertBrandContentAuthority(action, authority);
  if (authority === 'workflow' && !options.beforeCommit)
    fail('authority_denied');
  const digest = brandContentDigest({ action, authority });
  return { action, authority, digest };
}

/** Authority is injected by the authenticated route/broker/scheduler, never
 * read from raw input. This function performs no model call or external post. */
export async function mutateBrandContent(
  context: BrandContentIdentity,
  raw: unknown,
  options: BrandContentMutationOptions = {},
): Promise<BrandContentMutationReceipt> {
  const prepared = prepareMutation(raw, options);
  const db = options.db ?? getDatabase();
  return employeeAccessTransaction(db, (tx) =>
    applyMutationInTransaction(context, prepared, tx, options),
  );
}

/** Server-only composition with an existing artifact registration transaction.
 * The caller owns commit/rollback and must not catch a rejected mutation inside
 * that transaction. Neither raw input nor the public HTTP/tool schema accepts tx. */
export async function mutateBrandContentInTransaction(
  context: BrandContentIdentity,
  raw: unknown,
  tx: Tx,
  options: BrandContentTransactionOptions = {},
): Promise<BrandContentMutationReceipt> {
  return applyMutationInTransaction(
    context,
    prepareMutation(raw, options),
    tx,
    options,
  );
}

async function applyMutationInTransaction(
  context: BrandContentIdentity,
  { action, authority, digest }: ReturnType<typeof prepareMutation>,
  tx: Tx,
  options: BrandContentTransactionOptions,
): Promise<BrandContentMutationReceipt> {
  const scope = await requireBrandContentScope(
    tx,
    context,
    action,
    true,
    authority,
  );
  const lock = brandContentDigest({ ...scope, requestId: action.requestId });
  await tx`select pg_advisory_xact_lock(hashtextextended(${`brand-content:${lock}`},0))`;
  const [old] = await tx<
    { input_digest: string; response: BrandContentMutationReceipt }[]
  >`
      select input_digest,response from allrice_brand_content_requests
      where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
        and owner_id=${scope.ownerId} and instance_id=${scope.instanceId} and request_id=${action.requestId}`;
  if (old) {
    if (old.input_digest !== digest) fail('request_conflict');
    const response = BrandContentMutationReceiptSchema.parse(old.response);
    await recheckReceipt(tx, context, scope, action, response);
    await options.beforeCommit?.(tx);
    return { ...response, replayed: true };
  }
  const brandId = 'brandId' in action ? action.brandId : undefined;
  const brand = brandId ? await readBrand(tx, scope, brandId, true) : null;
  const applied = await applyAction(tx, context, scope, action, brand);
  const response = BrandContentMutationReceiptSchema.parse({
    operation: action.operation,
    requestId: action.requestId,
    replayed: false,
    result: applied,
  });
  await options.beforeCommit?.(tx);
  await tx`insert into allrice_brand_content_requests
      (organization_id,workspace_id,owner_id,instance_id,request_id,input_digest,authority,response)
      values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${action.requestId},${digest},${authority},${tx.json(response)})`;
  await tx`insert into allrice_audit_events
      (organization_id,workspace_id,actor_id,action,resource_type,resource_id,decision,reason,request_id,metadata)
      values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${`brand.content.${action.operation}`},'brand_content',${applied.entityId},'recorded','native_business_state',${context.requestId},
        ${tx.json({
          instanceId: scope.instanceId,
          authority,
          inputDigest: digest,
          workflow: action.workflow ?? null,
          ...(action.operation === 'topics.decide'
            ? { batchId: action.batchId, choices: action.choices }
            : {}),
        })})`;
  return response;
}
