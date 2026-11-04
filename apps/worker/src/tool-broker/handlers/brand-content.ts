import { BrandContentToolReadSchema } from '@allrice/contracts';
import {
  authorizeBrandContentTool,
  getBrandContentBoard,
  listBrandContentBrands,
} from '@allrice/database';
import { HandlerError } from '../../errors.js';
import type { RiceToolHandler, RiceToolHandlerContext } from '../types.js';

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
