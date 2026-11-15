import { randomUUID } from 'node:crypto';
import {
  BrandFeedbackInputSchema,
  BrandFeedbackSchema,
  BrandRetrospectiveSchema,
  brandRetrospectiveSource,
  type BrandContentAction,
  type BrandContentStageInput,
  type BrandContentMutationReceipt,
  type BrandFeedback,
} from '@allrice/contracts';
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
  return {
    feedback,
    retrospectives,
    unavailableFeedbackSources,
    truncated: samples.length > 200 || reports.length > 200,
  };
}
type FeedbackAction = Extract<
  BrandContentAction,
  {
    operation: 'feedback.record' | 'retrospective.save';
  }
>;
export async function applyBrandFeedback(
  tx: Tx,
  who: BrandContentIdentity,
  scope: Scope,
  action: FeedbackAction,
): Promise<BrandContentMutationReceipt['result']> {
  const brandId = action.brandId;
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
  return fail('invalid_state');
}
