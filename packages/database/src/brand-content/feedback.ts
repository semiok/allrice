import { createHash, randomUUID } from 'node:crypto';
import {
  BrandFeedbackInputSchema,
  BrandFeedbackSchema,
  BrandRetrospectiveSchema,
  BrandExperienceSchema,
  BrandExperiencePinSchema,
  brandRetrospectiveSource,
  type BrandContentAction,
  type BrandContentStageInput,
  type BrandContentMutationReceipt,
  type BrandFeedback,
  type RequestContext,
} from '@allrice/contracts';
import {
  createExperienceInTransaction,
  reviewExperienceInTransaction,
} from '../experience.ts';
import {
  assertBrandContentFile,
  assertBrandContentSession,
} from './authority.ts';
import { readBrandContext, scopedRow, assertBrandBundle } from './queries.ts';
import {
  BrandContentError,
  brandContentDigest,
  brandContentFail as fail,
} from './rules.ts';
import type {
  Tx,
  Scope,
  BrandContentIdentity,
  ReceiptRow,
  PlanRow,
  ArticleRow,
  BundleRow,
} from './types.ts';

type FeedbackRow = {
  id: string;
  context_id: string;
  content: unknown;
  digest: string;
  created_at: Date;
};
type RetrospectiveRow = {
  id: string;
  context_id: string;
  platform: string;
  campaign_key: string | null;
  feedback_ids: string[];
  output: unknown;
  source_text: string;
  run_id: string;
  session_id: string;
  created_at: Date;
};
/** Only feedback-specific attachment loss may hide a historical board entry.
 * Context, publication, ownership and integrity errors remain strict. */
class UnavailableFeedbackEvidence extends BrandContentError {
  constructor() {
    super('source_unavailable');
  }
}
const scopeSql = (tx: Tx, s: Scope, brandId: string) =>
  tx`organization_id=${s.organizationId} and workspace_id=${s.workspaceId} and owner_id=${s.ownerId} and instance_id=${s.instanceId} and brand_id=${brandId}`;
export function feedbackView(row: FeedbackRow): BrandFeedback {
  const value = BrandFeedbackInputSchema.parse(row.content);
  if (
    brandContentDigest(value) !== row.digest ||
    value.contextRevisionId !== row.context_id
  )
    fail('source_changed');
  return BrandFeedbackSchema.parse({
    ...value,
    id: row.id,
    digest: row.digest,
    createdAt: row.created_at.toISOString(),
  });
}
export async function readBrandFeedback(
  tx: Tx,
  who: BrandContentIdentity,
  scope: Scope,
  brandId: string,
  id: string,
  lock = true,
) {
  const [row] = await tx<
    FeedbackRow[]
  >`select * from allrice_brand_content_feedback where id=${id} and ${scopeSql(tx, scope, brandId)} ${lock ? tx`for share` : tx``}`;
  if (!row) fail('not_found');
  const value = feedbackView(row);
  await readBrandContext(
    tx,
    who,
    scope,
    brandId,
    value.contextRevisionId,
    lock,
  );
  if (value.receiptId) {
    const receipt = await scopedRow<ReceiptRow>(
      tx,
      scope,
      'receipts',
      brandId,
      value.receiptId,
      lock,
    );
    const plan = await scopedRow<PlanRow>(
      tx,
      scope,
      'plans',
      brandId,
      receipt.plan_id,
      lock,
    );
    const article = await scopedRow<ArticleRow>(
      tx,
      scope,
      'articles',
      brandId,
      plan.article_id,
      lock,
    );
    const bundle = await scopedRow<BundleRow>(
      tx,
      scope,
      'bundles',
      brandId,
      plan.bundle_id,
      lock,
    );
    await assertBrandBundle(tx, who, scope, brandId, article, bundle, lock);
    if (
      article.context_id !== value.contextRevisionId ||
      receipt.platform !== value.platform ||
      receipt.published_url !== value.publishedUrl ||
      receipt.actual_published_at.toISOString() !==
        new Date(value.publishedAt).toISOString()
    )
      fail('source_reference_invalid');
    for (const file of receipt.evidence_files)
      await assertBrandContentFile(tx, who, scope, file, false, lock);
  }
  let evidenceUnavailable = false;
  for (const file of value.evidenceFiles) {
    try {
      await assertBrandContentFile(tx, who, scope, file, false, lock);
    } catch (error) {
      if (
        error instanceof BrandContentError &&
        error.code === 'source_unavailable'
      ) {
        evidenceUnavailable = true;
      } else throw error;
    }
  }
  if (evidenceUnavailable) throw new UnavailableFeedbackEvidence();
  return value;
}
export async function readBrandRetrospective(
  tx: Tx,
  who: BrandContentIdentity,
  scope: Scope,
  brandId: string,
  id: string,
  lock = true,
) {
  const [row] = await tx<
    RetrospectiveRow[]
  >`select * from allrice_brand_content_retrospectives where id=${id} and ${scopeSql(tx, scope, brandId)} ${lock ? tx`for share` : tx``}`;
  if (!row) fail('not_found');
  const result = BrandRetrospectiveSchema.parse({
    id: row.id,
    contextRevisionId: row.context_id,
    platform: row.platform,
    campaignKey: row.campaign_key,
    feedbackIds: row.feedback_ids,
    output: row.output,
    sourceText: row.source_text,
    runId: row.run_id,
    sessionId: row.session_id,
    createdAt: row.created_at.toISOString(),
  });
  if (
    result.sourceText !== brandRetrospectiveSource(result.output, result.id) ||
    brandContentDigest(result.output.feedbackIds) !==
      brandContentDigest(result.feedbackIds)
  )
    fail('source_changed');
  await assertBrandContentSession(tx, who, scope, row.session_id, false, lock);
  await readBrandContext(tx, who, scope, brandId, row.context_id, lock);
  let evidenceUnavailable = false;
  for (const feedbackId of row.feedback_ids) {
    try {
      await readBrandFeedback(tx, who, scope, brandId, feedbackId, lock);
    } catch (error) {
      if (!(error instanceof UnavailableFeedbackEvidence)) throw error;
      evidenceUnavailable = true;
    }
  }
  if (evidenceUnavailable) throw new UnavailableFeedbackEvidence();
  return result;
}
export async function readBrandExperiences(
  tx: Tx,
  scope: Scope,
  brandId: string,
  lock = true,
) {
  const rows =
    await tx`select b.*,m.content,m.revision,m.archived_at,m.expires_at,e.status,e.proposed_digest
    from allrice_brand_content_experiences b join allrice_memories m on m.id=b.memory_id and m.organization_id=b.organization_id and m.workspace_id=b.workspace_id and m.owner_id=b.owner_id
    join allrice_experience_reviews e on e.memory_id=m.id and e.organization_id=m.organization_id and e.workspace_id=m.workspace_id and e.owner_id=m.owner_id
    where b.organization_id=${scope.organizationId} and b.workspace_id=${scope.workspaceId} and b.owner_id=${scope.ownerId} and b.instance_id=${scope.instanceId} and b.brand_id=${brandId}
    order by b.created_at desc,b.memory_id desc limit 201 ${lock ? tx`for share of b,m,e` : tx``}`;
  return rows.map((r) =>
    BrandExperienceSchema.parse({
      id: r.memory_id,
      revision: r.revision,
      digest: r.proposed_digest,
      content: r.content,
      retrospectiveId: r.retrospective_id,
      platform: r.platform,
      campaignKey: r.campaign_key,
      status: r.status,
      archived: Boolean(
        r.archived_at || (r.expires_at && r.expires_at <= new Date()),
      ),
    }),
  );
}
export async function assertBrandFeedbackInput(
  tx: Tx,
  who: BrandContentIdentity,
  scope: Scope,
  input: BrandContentStageInput,
) {
  for (const sample of input.feedback ?? []) {
    const current = await readBrandFeedback(
      tx,
      who,
      scope,
      input.brandId,
      sample.id,
    );
    if (
      brandContentDigest(sample) !== brandContentDigest(current) ||
      sample.platform !== input.platform ||
      sample.contextRevisionId !== input.contextRevisionId
    )
      fail('source_changed');
  }
  if (!input.experiences?.length) return;
  const current = await readBrandExperiences(tx, scope, input.brandId);
  for (const pin of input.experiences) {
    const row = current.find((x) => x.id === pin.id);
    if (
      !row ||
      row.archived ||
      row.status !== 'approved' ||
      row.platform !== input.platform ||
      row.campaignKey !== (input.context.campaign?.key ?? null) ||
      brandContentDigest(pin) !==
        brandContentDigest(
          BrandExperiencePinSchema.parse({
            id: row.id,
            revision: row.revision,
            digest: row.digest,
            content: row.content,
            retrospectiveId: row.retrospectiveId,
            platform: row.platform,
            campaignKey: row.campaignKey,
          }),
        ) ||
      row.digest !==
        `sha256:${createHash('sha256').update(row.content).digest('hex')}`
    )
      fail('source_changed');
    await readBrandRetrospective(
      tx,
      who,
      scope,
      input.brandId,
      pin.retrospectiveId,
    );
  }
}
export async function readBrandFeedbackBoard(
  tx: Tx,
  who: BrandContentIdentity,
  scope: Scope,
  brandId: string,
  lock = true,
) {
  const samples = await tx<
    FeedbackRow[]
  >`select * from allrice_brand_content_feedback where ${scopeSql(tx, scope, brandId)} order by created_at desc,id desc limit 201`;
  const reports = await tx<
    { id: string }[]
  >`select id from allrice_brand_content_retrospectives where ${scopeSql(tx, scope, brandId)} order by created_at desc,id desc limit 201`;
  let unavailableFeedbackSources = false;
  async function available<T>(read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof UnavailableFeedbackEvidence)) throw error;
      unavailableFeedbackSources = true;
      return undefined;
    }
  }
  const checkedReports = new Map<
    string,
    Awaited<ReturnType<typeof readBrandRetrospective>> | undefined
  >();
  async function availableReport(id: string) {
    if (!checkedReports.has(id))
      checkedReports.set(
        id,
        await available(() =>
          readBrandRetrospective(tx, who, scope, brandId, id, lock),
        ),
      );
    return checkedReports.get(id);
  }
  const feedback = [];
  for (const sample of samples.slice(0, 200)) {
    const value = await available(() =>
      readBrandFeedback(tx, who, scope, brandId, sample.id, lock),
    );
    if (value) feedback.push(value);
  }
  const retrospectives = [];
  for (const report of reports.slice(0, 200)) {
    const value = await availableReport(report.id);
    if (value) retrospectives.push(value);
  }
  const experienceRows = await readBrandExperiences(tx, scope, brandId, lock);
  const experiences = [];
  for (const experience of experienceRows.slice(0, 200))
    if (await availableReport(experience.retrospectiveId))
      experiences.push(experience);
  const uses =
    await tx`select u.*,b.retrospective_id from allrice_brand_content_experience_uses u
      join allrice_brand_content_experiences b on b.memory_id=u.memory_id
        and b.organization_id=u.organization_id and b.workspace_id=u.workspace_id
        and b.owner_id=u.owner_id and b.instance_id=u.instance_id and b.brand_id=u.brand_id
      where u.organization_id=${scope.organizationId} and u.workspace_id=${scope.workspaceId}
        and u.owner_id=${scope.ownerId} and u.instance_id=${scope.instanceId} and u.brand_id=${brandId}
      order by u.created_at desc,u.entity_id desc limit 201`;
  const experienceUses = [];
  // Uses and experiences have independent windows. Validate every use's report,
  // including an older memory absent from the visible experience list.
  for (const r of uses.slice(0, 200))
    if (await availableReport(r.retrospective_id))
      experienceUses.push({
        entityId: r.entity_id,
        memoryId: r.memory_id,
        revision: r.revision,
        digest: r.digest,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
      });
  return {
    feedback,
    retrospectives,
    experiences,
    experienceUses,
    unavailableFeedbackSources,
    truncated:
      samples.length > 200 ||
      reports.length > 200 ||
      experienceRows.length > 200 ||
      uses.length > 200,
  };
}
type FeedbackAction = Extract<
  BrandContentAction,
  {
    operation:
      | 'feedback.record'
      | 'retrospective.save'
      | 'experience.propose'
      | 'experience.review';
  }
>;
export async function applyBrandFeedback(
  tx: Tx,
  who: BrandContentIdentity,
  scope: Scope,
  action: FeedbackAction,
): Promise<BrandContentMutationReceipt['result']> {
  const brandId = action.brandId;
  if (action.operation === 'experience.review') {
    const entry = (await readBrandExperiences(tx, scope, brandId)).find(
      (x) => x.id === action.memoryId,
    );
    if (!entry) fail('not_found');
    if (action.decision === 'approve')
      await readBrandRetrospective(
        tx,
        who,
        scope,
        brandId,
        entry.retrospectiveId,
      );
    const reviewed = await reviewExperienceInTransaction(
      tx,
      { ...who, workspaceId: scope.workspaceId } as RequestContext,
      entry.id,
      {
        decision: action.decision,
        expectedRevision: action.expectedRevision,
        expectedDigest: action.expectedDigest,
        reason: action.reason,
      },
    );
    return {
      brandId,
      entityId: reviewed.id,
      revision: reviewed.revision,
      state: 'experience_reviewed',
    };
  }
  if (action.operation === 'feedback.record') {
    const value = BrandFeedbackInputSchema.strip().parse(action);
    if (Date.parse(value.sampledAt) > Date.now()) fail('receipt_invalid');
    await readBrandContext(tx, who, scope, brandId, value.contextRevisionId);
    for (const file of value.evidenceFiles)
      await assertBrandContentFile(tx, who, scope, file);
    const digest = brandContentDigest(value);
    const key = brandContentDigest({
      platform: value.platform,
      publishedUrl: value.publishedUrl,
      sampledAt: new Date(value.sampledAt).toISOString(),
      sourceUrl: value.sourceUrl,
    });
    const [prior] = await tx<
      FeedbackRow[]
    >`select * from allrice_brand_content_feedback where ${scopeSql(tx, scope, brandId)} and publication_key=${key}`;
    if (prior) {
      if (prior.digest !== digest) fail('request_conflict');
      await readBrandFeedback(tx, who, scope, brandId, prior.id);
      return {
        brandId,
        entityId: prior.id,
        revision: 1,
        state: 'feedback_recorded',
      };
    }
    const id = randomUUID();
    await tx`insert into allrice_brand_content_feedback(id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,content,digest,publication_key)
      values(${id},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${value.contextRevisionId},${tx.json(value)},${digest},${key})`;
    await readBrandFeedback(tx, who, scope, brandId, id);
    return { brandId, entityId: id, revision: 1, state: 'feedback_recorded' };
  }
  if (action.operation === 'retrospective.save') {
    const fixed = await readBrandContext(
      tx,
      who,
      scope,
      brandId,
      action.contextRevisionId,
    );
    await assertBrandContentSession(tx, who, scope, action.sessionId);
    const [run] =
      await tx`select execution_snapshot from allrice_employee_runs where run_id=${action.runId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and session_id=${action.sessionId} and status='running' for share`;
    const invocation = run?.execution_snapshot?.workflowInvocation;
    if (
      !invocation ||
      invocation.instanceId !== scope.instanceId ||
      invocation.input.stage !== 'retrospective' ||
      invocation.input.brandId !== brandId ||
      invocation.input.contextRevisionId !== fixed.id ||
      invocation.input.platform !== action.platform ||
      brandContentDigest(
        invocation.input.feedback.map((s: BrandFeedback) => s.id),
      ) !== brandContentDigest(action.output.feedbackIds) ||
      invocation.workflowRevisionId !== action.workflow?.workflowRevisionId ||
      invocation.packageDigest !== action.workflow?.packageDigest
    )
      fail('source_reference_invalid');
    for (const id of action.output.feedbackIds)
      await readBrandFeedback(tx, who, scope, brandId, id);
    const id = randomUUID(),
      source = brandRetrospectiveSource(action.output, id);
    if (source.length > 4000) fail('source_reference_invalid');
    await tx`insert into allrice_brand_content_retrospectives(id,organization_id,workspace_id,owner_id,instance_id,brand_id,context_id,platform,campaign_key,feedback_ids,output,source_text,run_id,session_id,workflow)
      values(${id},${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${brandId},${fixed.id},${action.platform},${fixed.content.campaign?.key ?? null},${action.output.feedbackIds},${tx.json(action.output)},${source},${action.runId},${action.sessionId},${tx.json(action.workflow!)})`;
    return { brandId, entityId: id, revision: 1, state: 'retrospective_saved' };
  }
  const report = await readBrandRetrospective(
    tx,
    who,
    scope,
    brandId,
    action.retrospectiveId,
  );
  const [run] =
    await tx`select assistant_message_id from allrice_employee_runs where run_id=${report.runId} and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId} and owner_id=${scope.ownerId} and session_id=${report.sessionId} and status='succeeded' and completed_at is not null for share`;
  if (!run?.assistant_message_id) fail('invalid_state');
  const created = await createExperienceInTransaction(
    tx,
    { ...who, workspaceId: scope.workspaceId } as RequestContext,
    {
      clientRequestId: report.id,
      runId: report.runId,
      messageId: run.assistant_message_id,
      sourceExcerpt: report.sourceText,
      content: report.sourceText,
      memoryClass: 'work_note',
      scope: 'private',
      shareAcknowledged: false,
    },
  );
  return {
    brandId,
    entityId: created.id,
    revision: created.revision,
    state: 'experience_proposed',
  };
}

export async function recordBrandExperienceUses(
  tx: Tx,
  who: BrandContentIdentity,
  scope: Scope,
  action: BrandContentAction,
  entityId: string,
) {
  if (!('experienceUses' in action) || !action.experienceUses?.length) return;
  const contextId =
    action.operation === 'topics.propose'
      ? action.contextRevisionId
      : (
          await scopedRow<ArticleRow>(
            tx,
            scope,
            'articles',
            action.brandId,
            entityId,
          )
        ).context_id;
  const fixed = await readBrandContext(
    tx,
    who,
    scope,
    action.brandId,
    contextId,
  );
  const platform =
    action.operation === 'topics.propose'
      ? action.platform
      : (
          await scopedRow<ArticleRow>(
            tx,
            scope,
            'articles',
            action.brandId,
            entityId,
          )
        ).platform;
  const savedEntityId =
    action.operation === 'article.submit'
      ? (
          await scopedRow<ArticleRow>(
            tx,
            scope,
            'articles',
            action.brandId,
            entityId,
          )
        ).current_bundle_id
      : entityId;
  const entries = await readBrandExperiences(tx, scope, action.brandId);
  for (const use of action.experienceUses) {
    const item = entries.find((x) => x.id === use.id);
    if (
      !item ||
      item.status !== 'approved' ||
      item.archived ||
      item.platform !== platform ||
      item.campaignKey !== (fixed.content.campaign?.key ?? null)
    )
      fail('source_reference_invalid');
    await readBrandRetrospective(
      tx,
      who,
      scope,
      action.brandId,
      item.retrospectiveId,
    );
    await tx`insert into allrice_brand_content_experience_uses(organization_id,workspace_id,owner_id,instance_id,brand_id,entity_id,memory_id,revision,digest,reason)
      values(${scope.organizationId},${scope.workspaceId},${scope.ownerId},${scope.instanceId},${action.brandId},${savedEntityId},${item.id},${item.revision},${item.digest},${use.reason})`;
  }
}
