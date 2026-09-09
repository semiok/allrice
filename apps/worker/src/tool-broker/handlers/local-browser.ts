import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  browserPrincipal,
  createLocalBrowserWorkspace,
  createBrowserOperation,
  requestBrowserControl,
  readCurrentBrowserWorkspace,
  cloudStableId,
  localBrowserEnabled,
} from '@allrice/database';
import { LocalBrowserToolInputSchema } from '../../browser-control/local-tool-input.js';
import { waitBrowserOperationResult } from '../../browser-control/controller.js';
import type { RiceToolHandler } from '../types.js';

/** Dispatch only. The Bridge drives local I/O under the existing Run/ledger;
 * no local Agent loop, folder permission or fallback cloud execution is created. */
export const runLocalBrowserWorkspace: RiceToolHandler = async ({
  input,
  arguments: raw,
}) => {
  const args = LocalBrowserToolInputSchema.parse(raw),
    ctx = browserPrincipal(input.context);
  if (
    !localBrowserEnabled() ||
    !input.managedBrowserJobAttempt ||
    !input.managedBrowserJobLeaseToken
  )
    throw Error('LOCAL_BROWSER_JOB_LEASE_REQUIRED');
  const assertOwned = async (id: string) => {
    const w = await readCurrentBrowserWorkspace(ctx, id);
    if (
      w.transport !== 'local' ||
      w.run_id !== input.context.runId ||
      w.job_id !== input.context.jobId ||
      w.worker_id !== input.context.worker.id ||
      w.job_attempt !== input.managedBrowserJobAttempt ||
      w.job_lease_token !== input.managedBrowserJobLeaseToken
    )
      throw Error('LOCAL_BROWSER_RUN_MISMATCH');
    return w;
  };
  if (args.command === 'close') {
    await assertOwned(args.workspaceId);
    await requestBrowserControl(ctx, args.workspaceId, {
      requestId: randomUUID(),
      expectedFence: args.fence,
      control: 'closed',
      observationId: null,
    });
    return {
      summary: '已请求关闭本地浏览器，等待 Bridge 实际停止确认',
      modelContent: JSON.stringify({
        requested: true,
        confirmedStopped: false,
        target: 'local',
      }),
    };
  }
  let payload;
  if (args.command === 'open') {
    let w = await createLocalBrowserWorkspace({
      context: input.context,
      callId: input.call.id,
      grantId: args.grantId,
      url: args.url,
      jobAttempt: input.managedBrowserJobAttempt,
      jobLeaseToken: input.managedBrowserJobLeaseToken,
    });
    const until = Date.now() + 20000;
    while (w.acknowledged_fence !== w.control_fence && Date.now() < until) {
      if (input.signal?.aborted) throw Error('LOCAL_BROWSER_CANCELED');
      await delay(100);
      w = await assertOwned(w.id);
    }
    if (w.state !== 'agent' || w.acknowledged_fence !== w.control_fence)
      throw Error('LOCAL_BROWSER_CONTROLLER_NOT_READY');
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
    await assertOwned(args.workspaceId);
    payload = {
      version: 1,
      workspaceId: args.workspaceId,
      profileId: args.profileId,
      actor: 'agent',
      fence: args.fence,
      observationId: args.command === 'observe' ? null : args.observationId,
      action: args.command === 'observe' ? { type: 'observe' } : args.action,
    };
  }
  const op = await createBrowserOperation(
    ctx,
    payload,
    cloudStableId(`local-browser-call:${input.context.runId}:${input.call.id}`),
  );
  const result = await waitBrowserOperationResult(
    ctx,
    op.workspace.id,
    op.snapshot.binding.attempt.operationId,
    undefined,
    input.signal,
  );
  return {
    summary: '本地浏览器操作结果已记录',
    modelContent: JSON.stringify({
      target: 'local',
      deviceId: op.workspace.device_id,
      workspaceId: op.workspace.id,
      profileId: op.workspace.profile_id,
      fence: op.workspace.control_fence,
      ...result,
    }),
  };
};
