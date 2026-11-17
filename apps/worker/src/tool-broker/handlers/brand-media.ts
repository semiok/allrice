import {
  brandMediaTools,
  BrandMediaCandidatesSchema,
  BrandMediaToolArticleSchema,
} from '@allrice/contracts';
import {
  authorizeBrandMediaTool,
  readBrandMediaTool,
  recordBrandMediaDelivery,
  submitBrandMediaArticle,
  publishWorkbenchArtifact,
  BrandMediaError,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { HandlerError } from '../../errors.js';
import type { RiceToolHandler, RiceToolHandlerContext } from '../types.js';

export function brandMediaWorkerCall({
  input,
  arguments: args,
}: RiceToolHandlerContext) {
  if (
    !input.sessionId ||
    !input.userMessageId ||
    input.platformTestRunId ||
    input.managedBrowserJobAttempt === undefined ||
    !input.managedBrowserJobLeaseToken
  )
    throw new HandlerError(
      'BRAND_MEDIA_AUTHORITY_UNAVAILABLE',
      '当前任务不能操作品牌自媒体记录。',
      false,
    );
  return {
    context: input.context,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    callId: input.call.id,
    arguments: args,
    worker: {
      attempt: input.managedBrowserJobAttempt,
      leaseToken: input.managedBrowserJobLeaseToken,
    },
  };
}
export const executeBrandMediaTool: RiceToolHandler = async (context) => {
  const { input } = context,
    call = brandMediaWorkerCall(context);
  const tool = brandMediaTools.find(
    (definition) => definition.canonicalName === input.call.name,
  );
  if (!tool)
    throw new HandlerError('TOOL_NOT_FOUND', '未找到品牌自媒体工具。', false);
  const args = tool.input.parse(context.arguments);
  if (tool.handlerRef === 'read')
    return {
      modelContent: JSON.stringify(await readBrandMediaTool(call, args)),
      summary: '已读取品牌自媒体记录',
    };
  const authority = await authorizeBrandMediaTool(call, tool.canonicalName);
  const candidates =
    tool.handlerRef === 'candidates'
      ? BrandMediaCandidatesSchema.parse(args)
      : undefined;
  const article =
    tool.handlerRef === 'article'
      ? BrandMediaToolArticleSchema.parse(args)
      : undefined;
  const intent = authority.invocation!.intent;
  if (
    article &&
    (intent.operation !== 'article' ||
      article.articleId !== intent.articleId ||
      article.expectedRevision !== intent.expectedRevision)
  )
    throw new HandlerError(
      'BRAND_MEDIA_TARGET_CONFLICT',
      '正文目标与本次固定请求不一致。',
      false,
    );
  input.signal?.throwIfAborted();
  const artifact = await publishWorkbenchArtifact(
    {
      context: input.context,
      sessionId: call.sessionId,
      callId: call.callId,
      fileName: candidates ? '选题候选.json' : '文章正文.txt',
      kind: 'document',
      format: candidates ? 'json' : 'text',
      mediaType: candidates ? 'application/json' : 'text/plain',
      bytes: Buffer.from(
        candidates ? JSON.stringify(candidates) : article!.body,
      ),
    },
    new LocalStorageAdapter(input.storageRoot),
    undefined,
    {
      requiredTool: tool.canonicalName,
      runId: input.context.runId,
      admit: (tx) => authority.beforeCommit(tx),
      registered: (tx, artifactId) =>
        recordBrandMediaDelivery(tx, call, tool.canonicalName, artifactId),
      replayed: (tx) => authority.beforeCommit(tx),
    },
  );
  const file = {
    objectId: artifact.object.id,
    versionId: artifact.id,
    checksum: artifact.object.checksum,
  };
  if (candidates)
    return {
      modelContent: JSON.stringify(
        tool.output.parse({
          ...candidates,
          file,
          runId: input.context.runId,
          addedToTopics: false,
        }),
      ),
      summary: '候选已交付，等待真人加入选题库',
    };
  input.signal?.throwIfAborted();
  try {
    const result = await submitBrandMediaArticle(call, {
      workspaceId: authority.scope.workspaceId,
      instanceId: authority.scope.instanceId,
      requestId: intent.requestId,
      articleId: article!.articleId,
      expectedRevision: article!.expectedRevision,
      title: article!.title,
      body: file,
    });
    return {
      modelContent: JSON.stringify(
        tool.output.parse({
          ...result,
          file,
          runId: input.context.runId,
          articleUpdated: true,
        }),
      ),
      summary: '正文已提交到本次文章修订',
    };
  } catch (error) {
    // The immutable delivery is already committed. Only known business CAS/state
    // failures become a visible conflict receipt; execution/transport errors stay errors.
    if (!(error instanceof BrandMediaError)) throw error;
    return {
      modelContent: JSON.stringify(
        tool.output.parse({
          file,
          runId: input.context.runId,
          articleUpdated: false,
          conflict: error.code,
        }),
      ),
      summary: '正文成果已保留，文章未更新，请核对当前修订',
    };
  }
};
