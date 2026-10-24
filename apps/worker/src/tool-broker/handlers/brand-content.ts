import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  BrandContentDraftOutputSchema,
  BrandRetrospectiveOutputSchema,
  summarizeBrandFeedback,
  type BrandContentStageInput,
  BrandContentTopicsOutputSchema,
  BrandContentToolReadSchema,
  type BrandContentMutationReceipt,
} from '@allrice/contracts';
import {
  authorizeBrandContentTool,
  getBrandContentBoard,
  getBrandContentPublishedVersion,
  getStoredFile,
  listBrandContentBrands,
  mutateBrandContent,
  mutateBrandContentInTransaction,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { HandlerError } from '../../errors.js';
import { createControlledWorkspaceExport } from './delivery.js';
import type { RiceToolHandler, RiceToolHandlerContext } from '../types.js';

const EnvelopeSchema = z
  .object({
    workflowInput: z.record(z.string(), z.unknown()),
    configured: z
      .object({
        action: z.enum([
          'load',
          'save_topics',
          'save_article',
          'handoff',
          'save_retrospective',
        ]),
        toolName: z.literal('workspace.brand_content.step'),
        requiredCapability: z.literal('storage:write'),
      })
      .strict(),
    dependencies: z.record(z.string(), z.unknown()),
  })
  .strict();

function call(context: RiceToolHandlerContext) {
  const { input } = context;
  if (
    !input.sessionId ||
    !input.userMessageId ||
    input.platformTestRunId ||
    input.managedBrowserJobAttempt === undefined ||
    !input.managedBrowserJobLeaseToken
  )
    throw new HandlerError(
      'BRAND_CONTENT_AUTHORITY_UNAVAILABLE',
      '当前任务不能读取或修改品牌业务记录。',
      false,
    );
  return {
    context: input.context,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    callId: input.call.id,
    arguments: context.arguments,
    worker: {
      attempt: input.managedBrowserJobAttempt,
      leaseToken: input.managedBrowserJobLeaseToken,
    },
  };
}

export const readBrandContent: RiceToolHandler = async (context) => {
  const args = BrandContentToolReadSchema.parse(context.arguments);
  const authority = await authorizeBrandContentTool(
    call(context),
    'workspace.brand_content.read',
  );
  const scope = {
    workspaceId: authority.context.workspaceId!,
    instanceId: authority.instanceId,
  };
  const options = {
    authority: 'workflow' as const,
    beforeCommit: authority.beforeCommit,
  };
  const result = args.brandId
    ? await getBrandContentBoard(
        authority.context,
        { ...scope, brandId: args.brandId },
        options,
      )
    : await listBrandContentBrands(authority.context, scope, options);
  return {
    modelContent: JSON.stringify(result),
    summary: '已读取当前员工的品牌内容记录',
  };
};

function composeOutput(dependencies: Record<string, unknown>) {
  const result = z
    .object({ answer: z.string() })
    .passthrough()
    .parse(dependencies.compose);
  try {
    return JSON.parse(result.answer);
  } catch {
    throw new HandlerError(
      'BRAND_CONTENT_OUTPUT_INVALID',
      '本次模型结果不是约定的 JSON，业务记录未保存；原输出和流程记录已保留。',
      false,
    );
  }
}

export function validateBrandExperienceUses(
  uses: Array<{ id: string; reason: string }> | undefined,
  input: BrandContentStageInput,
) {
  if (
    (uses ?? []).some(
      (use) => !(input.experiences ?? []).some((pin) => pin.id === use.id),
    )
  )
    throw new HandlerError(
      'BRAND_CONTENT_EXPERIENCE_REFERENCE_INVALID',
      '结果引用了本次未加载的经验，未保存。',
      false,
    );
}

export function renderBrandContentArticleMarkdown(
  draft: z.infer<typeof BrandContentDraftOutputSchema>,
) {
  const sourceNotes = `---\n\n资料依据：${draft.factIds.join('、') || '本次品牌资料中的文字要求'}。${draft.verificationNotes.length ? `\n\n待核实：\n${draft.verificationNotes.map((note) => `- ${note}`).join('\n')}` : ''}`;
  const markdown = draft.markdown.trimEnd();
  if (markdown === sourceNotes || markdown.endsWith(`\n\n${sourceNotes}`))
    return draft.markdown.endsWith('\n')
      ? draft.markdown
      : `${draft.markdown}\n`;
  return `${draft.markdown}\n\n${sourceNotes}\n`;
}

/** The Broker also matches this exact envelope and stable call ID to a running
 * durable DAG step. A model cannot submit a different action or fake dependencies. */
export const executeBrandContentStep: RiceToolHandler = async (context) => {
  const envelope = EnvelopeSchema.parse(context.arguments);
  const authority = await authorizeBrandContentTool(
    call(context),
    'workspace.brand_content.step',
  );
  const invocation = authority.invocation;
  if (!invocation)
    throw new HandlerError(
      'BRAND_CONTENT_WORKFLOW_REQUIRED',
      '请从内容工作台启动准确的业务流程。',
      false,
    );
  const value = invocation.input;
  const scope = {
    workspaceId: authority.context.workspaceId!,
    instanceId: authority.instanceId,
    brandId: value.brandId,
  };
  const options = {
    authority: 'workflow' as const,
    beforeCommit: authority.beforeCommit,
  };
  const board = await getBrandContentBoard(authority.context, scope, options);
  const fixedContext = board.contexts.find(
    (row) => row.id === value.contextRevisionId,
  );
  if (!fixedContext || fixedContext.digest !== value.contextDigest)
    throw new HandlerError(
      'BRAND_CONTENT_SOURCE_CHANGED',
      '固定品牌资料已不可用，未换用其他资料版本。',
      false,
    );
  const action = envelope.configured.action;
  if (action === 'load') {
    let originalMarkdown: string | undefined;
    if (value.article) {
      const file = await getStoredFile(
        authority.context,
        value.article.content.objectId,
      );
      if (
        file.object.checksum !== value.article.content.checksum ||
        file.object.sizeBytes > 800_000
      )
        throw new HandlerError(
          'BRAND_CONTENT_SOURCE_CHANGED',
          '原稿文件与固定版本不一致。',
          false,
        );
      const stream = await new LocalStorageAdapter(
        context.input.storageRoot,
      ).get(file.object);
      const bytes = Buffer.from(await new Response(stream).arrayBuffer());
      if (
        `sha256:${createHash('sha256').update(bytes).digest('hex')}` !==
        file.object.checksum
      )
        throw new HandlerError(
          'BRAND_CONTENT_SOURCE_CHANGED',
          '原稿文件校验失败，未将其他内容作为原稿。',
          false,
        );
      originalMarkdown = bytes.toString('utf8');
    }
    await authorizeBrandContentTool(
      call(context),
      'workspace.brand_content.step',
    );
    return {
      modelContent: JSON.stringify({
        ...value,
        ...(value.feedback
          ? { metricSummary: summarizeBrandFeedback(value.feedback) }
          : {}),
        ...(originalMarkdown !== undefined ? { originalMarkdown } : {}),
        existingTopics: board.topics
          .filter((row) => row.platform === value.platform)
          .map((row) => ({ title: row.candidate.title, state: row.state })),
      }),
      summary: '已读取本次固定版本的品牌资料与业务输入',
    };
  }
  const workflow = {
    workflowRevisionId: invocation.workflowRevisionId,
    packageDigest: invocation.packageDigest,
  };
  const requestId = context.input.call.id;
  if (action === 'save_retrospective' && value.stage === 'retrospective') {
    const output = BrandRetrospectiveOutputSchema.parse(
      composeOutput(envelope.dependencies),
    );
    if (
      JSON.stringify(output.feedbackIds) !==
      JSON.stringify(value.feedback?.map((sample) => sample.id))
    )
      throw new HandlerError(
        'BRAND_CONTENT_FEEDBACK_REFERENCE_INVALID',
        '复盘来源必须准确对应本次选定样本。',
        false,
      );
    const receipt = await mutateBrandContent(
      authority.context,
      {
        ...scope,
        operation: 'retrospective.save',
        requestId,
        workflow,
        contextRevisionId: value.contextRevisionId,
        platform: value.platform,
        runId: context.input.context.runId,
        sessionId: context.input.sessionId!,
        output,
      },
      options,
    );
    const updated = await getBrandContentBoard(
      authority.context,
      scope,
      options,
    );
    const report = updated.retrospectives?.find(
      (row) => row.id === receipt.result.entityId,
    );
    if (!report)
      throw new HandlerError(
        'BRAND_CONTENT_PUBLICATION_UNCONFIRMED',
        '复盘保存结果未确认。',
        false,
      );
    return {
      modelContent: JSON.stringify({ ...receipt, retrospective: report }),
      summary: `${output.summary}\n\n${report.sourceText}\n\n复盘已保存。可在内容工作台提交经验候选，确认后仅供相同品牌、活动和平台的后续任务使用。`,
      itemCount: 1,
    };
  }
  if (action === 'save_topics' && value.stage === 'topics') {
    const output = BrandContentTopicsOutputSchema.parse(
      composeOutput(envelope.dependencies),
    );
    validateBrandExperienceUses(output.experienceUses, value);
    const facts = new Set(value.context.facts.map((fact) => fact.id));
    if (
      output.candidates.some((candidate) =>
        candidate.factIds.some((id) => !facts.has(id)),
      )
    )
      throw new HandlerError(
        'BRAND_CONTENT_FACT_REFERENCE_INVALID',
        '候选引用了本次资料中不存在的事实编号，未保存候选。',
        false,
      );
    const receipt = await mutateBrandContent(
      authority.context,
      {
        ...scope,
        operation: 'topics.propose',
        requestId,
        workflow,
        contextRevisionId: value.contextRevisionId,
        platform: value.platform,
        candidates: output.candidates,
        ...(output.experienceUses
          ? { experienceUses: output.experienceUses }
          : {}),
      },
      options,
    );
    return {
      modelContent: JSON.stringify(receipt),
      summary: `已保存 ${receipt.result.topicIds?.length ?? 0} 个候选选题，请在内容工作台采纳或弃选。`,
      itemCount: receipt.result.topicIds?.length ?? 0,
    };
  }
  if (
    action === 'save_article' &&
    (value.stage === 'article' || value.stage === 'revision') &&
    value.topic
  ) {
    const draft = BrandContentDraftOutputSchema.parse(
      composeOutput(envelope.dependencies),
    );
    validateBrandExperienceUses(draft.experienceUses, value);
    const facts = new Set(value.context.facts.map((fact) => fact.id));
    if (
      new Set(draft.factIds).size !== draft.factIds.length ||
      draft.factIds.some((id) => !facts.has(id))
    )
      throw new HandlerError(
        'BRAND_CONTENT_FACT_REFERENCE_INVALID',
        '稿件引用了本次资料中不存在或重复的事实编号，未发布稿件。',
        false,
      );
    const changeSummary =
      value.stage === 'revision'
        ? `按退回意见修订：${value.article!.feedback}`.slice(0, 2000)
        : '根据已采纳选题首次成稿';
    let receipt: BrandContentMutationReceipt | undefined;
    const composition: NonNullable<
      Parameters<typeof createControlledWorkspaceExport>[1]
    > = {
      runId: context.input.context.runId,
      requiredTool: 'workspace.brand_content.step',
      admit: authority.beforeCommit,
    };
    composition.registered = composition.replayed = async (tx, artifactId) => {
      const content = await getBrandContentPublishedVersion(
        authority.context,
        context.input.sessionId!,
        artifactId,
        tx,
      );
      receipt = await mutateBrandContentInTransaction(
        authority.context,
        {
          ...scope,
          operation: 'article.submit',
          requestId,
          workflow,
          ...(value.article
            ? {
                articleId: value.article.id,
                parentVersionId: value.article.content.versionId,
              }
            : {}),
          expectedRevision: value.article?.expectedRevision ?? 0,
          topicId: value.topic!.id,
          sessionId: context.input.sessionId!,
          content,
          images: value.article?.images ?? [],
          changeSummary,
          ...(draft.experienceUses
            ? { experienceUses: draft.experienceUses }
            : {}),
        },
        tx,
        options,
      );
    };
    const exported = await createControlledWorkspaceExport(
      {
        input: {
          ...context.input,
          call: {
            ...context.input.call,
            id: `${requestId}:document`,
            name: 'workspace.export.create',
          },
        },
        arguments: {
          format: 'markdown',
          fileName: `${draft.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.md`,
          content: renderBrandContentArticleMarkdown(draft),
          artifactKind: 'document',
          ...(value.article
            ? { parentObjectId: value.article.content.objectId }
            : {}),
          changeSummary,
        },
      },
      composition,
    );
    if (!receipt)
      throw new HandlerError(
        'BRAND_CONTENT_PUBLICATION_UNCONFIRMED',
        '稿件和业务版本的共同提交尚未确认，请保留当前任务记录。',
        false,
      );
    return {
      modelContent: JSON.stringify({
        ...receipt,
        delivery: JSON.parse(exported.modelContent),
      }),
      summary: `${exported.summary}；已提交这一图文版本，等待你审稿。`,
      itemCount: 1,
    };
  }
  if (action === 'handoff' && value.stage === 'handoff' && value.article) {
    const article = board.articles.find((row) => row.id === value.article!.id);
    const bundle = board.bundles.find(
      (row) => row.id === article?.currentBundleId,
    );
    const review = board.reviews.find(
      (row) => row.bundleId === bundle?.id && row.decision === 'approved',
    );
    if (
      article?.state !== 'approved' ||
      bundle?.digest !== value.article.bundleDigest ||
      !review
    )
      throw new HandlerError(
        'BRAND_CONTENT_REVIEW_CHANGED',
        '当前图文组合尚未通过准确版本审核，未制作发布交接。',
        false,
      );
    return {
      modelContent: JSON.stringify({
        articleId: article.id,
        bundleDigest: bundle.digest,
        reviewId: review.id,
        platform: article.platform,
        content: bundle.content,
        images: bundle.images,
        plans: board.plans.filter(
          (plan) => plan.bundleDigest === bundle.digest,
        ),
        published: false,
      }),
      summary:
        '已核对准确的已审图文版本，可在内容工作台登记排期并交接给发布人；实际发布后再填写真实回执。',
    };
  }
  throw new HandlerError(
    'BRAND_CONTENT_STAGE_MISMATCH',
    '节点动作与本次固定业务阶段不一致，未修改业务记录。',
    false,
  );
};
