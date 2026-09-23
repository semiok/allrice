import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  browserPrincipal,
  createBrowserWorkspace,
  createBrowserOperation,
  requestBrowserControl,
  readCurrentBrowserWorkspace,
  cloudStableId,
  linkTaskOperationCall,
  getDatabase,
} from '@allrice/database';
import { BrowserWorkspaceToolInputSchema } from '../../browser-control/tool-input.js';
import {
  startBrowserWorkspaceController,
  ownedBrowserController,
  waitBrowserOperationResult,
} from '../../browser-control/controller.js';
import type { RiceToolHandler } from '../types.js';

export const runBrowserWorkspace: RiceToolHandler = async ({
  input,
  arguments: raw,
}) => {
  const args = BrowserWorkspaceToolInputSchema.parse(raw),
    ctx = browserPrincipal(input.context);
  if (!input.managedBrowserJobAttempt || !input.managedBrowserJobLeaseToken)
    throw Error('BROWSER_JOB_LEASE_REQUIRED');
  if (args.command === 'close') {
    ownedBrowserController(
      args.workspaceId,
      input.context.jobId,
      input.context.worker.id,
    );
    await requestBrowserControl(ctx, args.workspaceId, {
      requestId: randomUUID(),
      expectedFence: args.fence,
      control: 'closed',
      observationId: null,
    });
    return {
      summary: '已请求关闭浏览器，等待实际停止确认',
      modelContent: JSON.stringify({
        requested: true,
        confirmedStopped: false,
      }),
    };
  }
  let payload;
  if (args.command === 'open') {
    let w = await createBrowserWorkspace({
      context: input.context,
      callId: input.call.id,
      url: args.url,
      jobAttempt: input.managedBrowserJobAttempt,
      jobLeaseToken: input.managedBrowserJobLeaseToken,
    });
    startBrowserWorkspaceController(w, {
      storage: new LocalStorageAdapter(input.storageRoot),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const until = Date.now() + 20000;
    while (w.acknowledged_fence !== w.control_fence && Date.now() < until) {
      if (input.signal?.aborted) throw Error('BROWSER_CANCELED');
      await delay(100);
      w = await readCurrentBrowserWorkspace(ctx, w.id);
    }
    if (w.state !== 'agent' || w.acknowledged_fence !== w.control_fence)
      throw Error('BROWSER_CONTROLLER_NOT_READY');
    payload = {
      version: 1,
      workspaceId: w.id,
      profileId: w.profile_id,
      actor: 'agent',
      fence: w.control_fence,
      observationId: null,
      action: { type: 'navigate', url: args.url },
    };
  } else {
    ownedBrowserController(
      args.workspaceId,
      input.context.jobId,
      input.context.worker.id,
    );
    payload = {
      version: 1,
      workspaceId: args.workspaceId,
      profileId: args.profileId,
      actor: 'agent',
      fence: args.fence,
      observationId: args.observationId,
      action: args.action,
    };
  }
  const op = await createBrowserOperation(
    ctx,
    payload,
    cloudStableId(`browser-call:${input.context.runId}:${input.call.id}`),
  );
  await linkTaskOperationCall(
    getDatabase(),
    op.snapshot.binding.attempt.operationId,
    input.call.id,
  );
  const result = await waitBrowserOperationResult(
    ctx,
    op.workspace.id,
    op.snapshot.binding.attempt.operationId,
    undefined,
    input.signal,
  );
  return {
    summary: '浏览器操作结果已记录',
    modelContent: JSON.stringify({
      workspaceId: op.workspace.id,
      profileId: op.workspace.profile_id,
      fence: op.workspace.control_fence,
      ...result,
    }),
  };
};
