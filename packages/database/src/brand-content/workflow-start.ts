import { assertBrandFeedbackInput } from './feedback.ts';
import { randomUUID } from 'node:crypto';
import {
  BrandContentStageInputSchema,
  BrandExperiencePinSchema,
  BrandContentWorkflowInvocationSchema,
  StartBrandContentWorkflowSchema,
  brandContentTemplateKeys,
  type BrandContentBoard,
  type BrandContentWorkflowInvocation,
  type RequestContext,
  type StartBrandContentWorkflow,
} from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';
import { DataAccessError } from '../data.ts';
import { runtimePolicyDigest } from '../runtime-policy.ts';
import {
  assertWorkflowPackageExecution,
  listWorkflowPackages,
} from '../capabilities/workflow-packages.ts';
import { employeeChatUuid } from '../employees/employee-chat-authority.ts';
import { requireBrandContentScope } from './authority.ts';
import { getBrandContentBoard } from './reads.ts';
import { brandContentFail as fail } from './rules.ts';
import type { BrandContentDatabase, Tx } from './types.ts';

export function brandContentStageInput(
  board: BrandContentBoard,
  request: StartBrandContentWorkflow,
) {
  const article = request.articleId
    ? board.articles.find((row) => row.id === request.articleId)
    : undefined;
  const topic = board.topics.find(
    (row) => row.id === (article?.topicId ?? request.topicId),
  );
  if (
    !['topics', 'retrospective'].includes(request.stage) &&
    (!topic || topic.state !== 'accepted')
  )
    fail('invalid_state');
  const bundle = article
    ? board.bundles.find((row) => row.id === article.currentBundleId)
    : undefined;
  const feedback =
    request.stage === 'retrospective'
      ? (request.feedbackIds ?? []).map((id) => {
          const sample = board.feedback?.find((row) => row.id === id);
          if (!sample) fail('source_unavailable');
          return sample;
        })
      : [];
  if (
    request.stage === 'retrospective' &&
    (!feedback.length ||
      feedback.some(
        (sample) =>
          sample.platform !== feedback[0]!.platform ||
          sample.contextRevisionId !== feedback[0]!.contextRevisionId,
      ))
  )
    fail('source_reference_invalid');
  const context = board.contexts.find(
    (row) =>
      row.id ===
      (feedback[0]?.contextRevisionId ??
        topic?.contextRevisionId ??
        board.brand.contextRevisionId),
  );
  if (!context) fail('source_unavailable');
  if (
    (request.stage === 'revision' || request.stage === 'handoff') &&
    (!article || !bundle)
  )
    fail('source_unavailable');
  const review = bundle
    ? board.reviews.find(
        (row) =>
          row.articleId === article?.id &&
          row.bundleId === bundle.id &&
          row.bundleDigest === bundle.digest,
      )
    : undefined;
  if (
    request.stage === 'revision' &&
    (article?.state !== 'changes_requested' || review?.decision !== 'rejected')
  )
    fail('invalid_state');
  if (
    request.stage === 'handoff' &&
    (article?.state !== 'approved' ||
      review?.decision !== 'approved' ||
      review.bundleDigest !== bundle?.digest)
  )
    fail('invalid_state');
  const platform =
    request.stage === 'topics'
      ? request.platform
      : request.stage === 'retrospective'
        ? feedback[0]?.platform
        : topic?.platform;
  const experiences = ['topics', 'article', 'revision'].includes(request.stage)
    ? (board.experiences ?? [])
        .filter(
          (row) =>
            row.status === 'approved' &&
            !row.archived &&
            row.platform === platform &&
            row.campaignKey === (context.content.campaign?.key ?? null),
        )
        .slice(0, 20)
        .map((row) =>
          BrandExperiencePinSchema.parse({
            id: row.id,
            revision: row.revision,
            digest: row.digest,
            content: row.content,
            retrospectiveId: row.retrospectiveId,
            platform: row.platform,
            campaignKey: row.campaignKey,
          }),
        )
    : [];
  return BrandContentStageInputSchema.parse({
    ...(feedback.length ? { feedback } : {}),
    ...(experiences.length ? { experiences } : {}),
    stage: request.stage,
    brandId: board.brand.id,
    brandName: context.brandName,
    contextRevisionId: context.id,
    contextDigest: context.digest,
    context: context.content,
    platform,
    ...(request.stage === 'topics' ? { count: request.count ?? 3 } : {}),
    ...(topic ? { topic: { id: topic.id, candidate: topic.candidate } } : {}),
    ...(article && bundle
      ? {
          article: {
            id: article.id,
            expectedRevision: article.revision,
            content: bundle.content,
            bundleDigest: bundle.digest,
            images: bundle.images,
            feedback: review?.reason ?? '',
          },
        }
      : {}),
  });
}

type StartRow = {
  id: string;
  request_digest: string;
  invocation: unknown;
  session_id: string;
  run_id: string | null;
};

/** Persist the human's exact stage input before queueing an ordinary employee
 * message. A lost HTTP response reuses the same session/message/Run. */
export async function startBrandContentWorkflow(
  context: RequestContext,
  instanceId: string,
  raw: unknown,
) {
  const request = StartBrandContentWorkflowSchema.parse(raw);
  const scope = { workspaceId: request.workspaceId, instanceId };
  const sql = getDatabase();
  const digest = runtimePolicyDigest(request);
  const readPrior = () =>
    sql.begin(async (tx) => {
      const current = await requireBrandContentScope(tx, context, scope, true);
      const [prior] = await tx<
        StartRow[]
      >`select * from allrice_brand_content_workflow_starts
        where organization_id=${current.organizationId} and workspace_id=${current.workspaceId}
          and owner_id=${current.ownerId} and instance_id=${current.instanceId}
          and request_id=${request.requestId}`;
      if (prior && prior.request_digest !== digest) fail('request_conflict');
      return prior;
    });
  let start = await readPrior();
  if (!start) {
    const board = await getBrandContentBoard(context, {
      ...scope,
      brandId: request.brandId,
    });
    const value = brandContentStageInput(board, request);
    const packages = await listWorkflowPackages(context, {
      ...scope,
      sceneId: null,
    });
    const selected = packages.find(
      (row) =>
        row.package.manifest.templateKey ===
          brandContentTemplateKeys[request.stage] &&
        row.binding?.enabled &&
        row.binding.workflowRevisionId === row.package.workflow.id,
    );
    if (!selected) throw new DataAccessError('not_found');
    const article = request.articleId
      ? board.articles.find((row) => row.id === request.articleId)
      : undefined;
    if (article && request.sessionId && request.sessionId !== article.sessionId)
      fail('source_reference_invalid');
    const sessionId =
      article?.sessionId ??
      request.sessionId ??
      employeeChatUuid(
        context.organizationId,
        request.workspaceId,
        instanceId,
        'brand-content-session',
        request.requestId,
      );
    const invocation = BrandContentWorkflowInvocationSchema.parse({
      schemaVersion: 1,
      startId: randomUUID(),
      instanceId,
      sceneId: null,
      workflowRevisionId: selected.package.workflow.id,
      packageDigest: selected.package.checksum,
      templateKey: selected.package.manifest.templateKey,
      input: value,
    });
    start = await sql.begin(async (tx) => {
      const current = await requireBrandContentScope(tx, context, scope, true);
      await tx`select pg_advisory_xact_lock(hashtextextended(${`brand-content-start:${current.organizationId}:${current.ownerId}:${instanceId}:${request.requestId}`},0))`;
      const [prior] = await tx<
        StartRow[]
      >`select * from allrice_brand_content_workflow_starts
        where organization_id=${current.organizationId} and workspace_id=${current.workspaceId}
          and owner_id=${current.ownerId} and instance_id=${instanceId} and request_id=${request.requestId}`;
      if (prior) {
        if (prior.request_digest !== digest) fail('request_conflict');
        return prior;
      }
      await assertWorkflowPackageExecution(
        context,
        {
          ...scope,
          sceneId: null,
          workflowRevisionId: invocation.workflowRevisionId,
        },
        tx,
        true,
      );
      await assertBrandFeedbackInput(tx, context, current, value);
      const [saved] = await tx<
        StartRow[]
      >`insert into allrice_brand_content_workflow_starts
        (id,organization_id,workspace_id,owner_id,instance_id,brand_id,request_id,request_digest,request,invocation,session_id)
        values(${invocation.startId},${current.organizationId},${current.workspaceId},${current.ownerId},${instanceId},${request.brandId},${request.requestId},${digest},${tx.json(request)},${tx.json(invocation)},${sessionId}) returning *`;
      if (!saved) fail('invalid_state');
      return saved;
    });
  }
  const invocation = BrandContentWorkflowInvocationSchema.parse(
    start.invocation,
  );
  await assertWorkflowPackageExecution(context, {
    ...scope,
    sceneId: invocation.sceneId,
    workflowRevisionId: invocation.workflowRevisionId,
    frozenPackageDigest: invocation.packageDigest,
  });
  const { createChatSession, sendChatMessage } =
    await import('../workspace/service.ts');
  const session = await createChatSession(
    context,
    {
      workspaceId: request.workspaceId,
      employeeInstanceId: instanceId,
      title: `${invocation.input.brandName} · ${
        {
          topics: '选题策划',
          article: '稿件制作',
          revision: '稿件修订',
          handoff: '发布交接',
          retrospective: '发布复盘',
        }[request.stage]
      }`,
    },
    { sessionId: start.session_id },
  );
  // Private business facts must never be injected into a workspace-public chat.
  if (session.visibility !== 'private') fail('authority_denied');
  const response = await sendChatMessage(
    context,
    request.workspaceId,
    session.id,
    {
      clientMessageId: request.requestId,
      text: `执行品牌内容工作流：${invocation.input.brandName} · ${invocation.input.stage}。使用本次已固定的资料与流程版本，完成这一阶段后交由我确认。`,
      deliveryMode: 'follow_up',
    },
    { workflowInvocation: invocation },
  );
  await sql`update allrice_brand_content_workflow_starts set run_id=${response.run.id}
    where id=${start.id} and organization_id=${context.organizationId}
      and workspace_id=${request.workspaceId} and owner_id=${context.actor.id}
      and (run_id is null or run_id=${response.run.id})`;
  return {
    sessionId: session.id,
    runId: response.run.id,
    created: response.created,
  };
}

/** Only persisted authenticated starts can create a business workflow snapshot. */
export async function assertBrandContentWorkflowStart(
  context: Pick<RequestContext, 'actor' | 'organizationId'>,
  sessionId: string,
  userMessageId: string,
  invocation: BrandContentWorkflowInvocation,
  callerSql?: BrandContentDatabase | Tx,
) {
  if (context.actor.type !== 'user')
    throw new DataAccessError('authorization_denied');
  // Admission can have just inserted the user message in the caller's open
  // transaction. A separate pool connection cannot observe that message yet.
  const sql = callerSql ?? getDatabase();
  const [row] = await sql<
    { invocation: unknown }[]
  >`select start.invocation from allrice_brand_content_workflow_starts start
    join allrice_messages m on m.session_id=start.session_id and m.client_message_id=start.request_id
      and m.organization_id=start.organization_id and m.workspace_id=start.workspace_id
      and m.owner_id=start.owner_id and m.role='user'
    where start.id=${invocation.startId} and start.session_id=${sessionId}
      and start.organization_id=${context.organizationId} and start.owner_id=${context.actor.id}
      and start.instance_id=${invocation.instanceId} and m.id=${userMessageId}`;
  if (
    !row ||
    runtimePolicyDigest(row.invocation) !== runtimePolicyDigest(invocation)
  )
    throw new DataAccessError('authorization_denied');
}
