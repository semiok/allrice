import { setTimeout as delay } from 'node:timers/promises';
import { LocalPreviewOpenInputSchema } from '@allrice/contracts';
import {
  browserPrincipal,
  createLocalPreviewWorkspace,
  requestLocalPreviewNavigation,
} from '@allrice/database';
import type { RiceToolHandler } from '../types.js';
import { waitBrowserOperationResult } from '../../browser-control/controller.js';

export const runLocalPreview: RiceToolHandler = async ({
  input,
  arguments: raw,
}) => {
  const args = LocalPreviewOpenInputSchema.parse(raw);
  if (!input.managedBrowserJobAttempt || !input.managedBrowserJobLeaseToken)
    throw Error('LOCAL_PREVIEW_JOB_LEASE_REQUIRED');
  const w = await createLocalPreviewWorkspace({
    context: input.context,
    processId: args.processId,
    jobAttempt: input.managedBrowserJobAttempt,
    jobLeaseToken: input.managedBrowserJobLeaseToken,
  });
  const principal = browserPrincipal(input.context),
    until = Date.now() + 5000;
  let result = await requestLocalPreviewNavigation(principal, w.id);
  while (result.pending && Date.now() < until && !input.signal?.aborted) {
    await delay(150);
    result = await requestLocalPreviewNavigation(principal, w.id);
  }
  if (input.signal?.aborted) throw Error('LOCAL_PREVIEW_CANCELED');
  if (result.operationId) {
    // Keep this Run alive while its existing browser approval is outstanding.
    // Returning only an approval ID here could let the model finish the Run
    // and invalidate both the service and preview before the user approves.
    const outcome = await waitBrowserOperationResult(
      principal,
      w.id,
      result.operationId,
      undefined,
      input.signal,
    );
    return {
      summary: '专属服务预览的导航结果已记录',
      modelContent: JSON.stringify({
        ...result,
        ...outcome,
        processId: args.processId,
        target: 'local_preview',
      }),
    };
  }
  return {
    summary: '专属预览已申请，等待 Bridge 启用项目预览并连接',
    modelContent: JSON.stringify({
      ...result,
      executed: false,
      processId: args.processId,
      target: 'local_preview',
    }),
  };
};
