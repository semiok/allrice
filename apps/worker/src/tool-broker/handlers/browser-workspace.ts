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
  createLocalBrowserWorkspace,
  selectBrowserExecution,
  executionResourceObserver,
  RuntimePolicyError,
  listLocalBrowserGrants,
} from '@allrice/database';
import { resolveExecutionChoice } from '@allrice/contracts';
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
  if (args.command === 'profiles') {
    const profiles = (await listLocalBrowserGrants(ctx)).filter(
      (p) => p.enabled,
    );
    return {
      summary: `已读取 ${profiles.length} 个本地浏览器环境`,
      modelContent: JSON.stringify({
        profiles: profiles.map((p) => ({
          grantId: p.grantId,
          deviceId: p.deviceId,
          deviceName: p.deviceName,
          network: p.profile.network ?? 'exact_public_sites',
          origins: p.profile.origins,
          persistLogin: p.persistLogin,
          accountState:
            'User-managed dedicated login; credentials and cookies are not exposed. This list is not proof of an active business login.',
        })),
      }),
    };
  }
  const assertOwned = async (id: string) => {
    const w = await readCurrentBrowserWorkspace(ctx, id);
    if (w.transport === 'cloud')
      ownedBrowserController(id, input.context.jobId, input.context.worker.id);
    else if (
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
    const workspace = await assertOwned(args.workspaceId);
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
        executionLocation: workspace.transport,
        executionReason: 'bound_execution',
      }),
    };
  }
  let payload;
  let executionReason = 'bound_execution';
  if (args.command === 'open') {
    const admission = {
      context: input.context,
      callId: input.call.id,
      url: args.url,
      jobAttempt: input.managedBrowserJobAttempt,
      jobLeaseToken: input.managedBrowserJobLeaseToken,
      location: args.location,
      requireLocalInputs: args.requireLocalInputs,
      grantId: args.grantId,
    };
    const observer = executionResourceObserver({
      context: input.context,
      leaseToken: input.managedBrowserJobLeaseToken,
      attemptId: cloudStableId(
        `browser-admission:${input.context.runId}:${input.call.id}`,
      ),
      callId: input.call.id,
    });
    let waiting = false;
    const wait = async (reason: 'local_busy' | 'local_preparing') => {
      await observer.observe({ stage: waiting ? 'waiting' : 'queued', reason });
      waiting = true;
      await delay(500, undefined, { signal: input.signal });
    };
    let w;
    try {
      for (;;) {
        input.signal?.throwIfAborted();
        const selection = await selectBrowserExecution(admission);
        executionReason = selection.selectionReason;
        if (selection.choice.status === 'reconcile')
          throw Error('BROWSER_RECONCILIATION_REQUIRED');
        if (selection.choice.status === 'unavailable')
          throw Error(
            `BROWSER_EXECUTION_UNAVAILABLE:${selection.choice.reason}`,
          );
        if (selection.choice.status === 'wait') {
          await wait(
            selection.choice.reason === 'local_busy'
              ? 'local_busy'
              : 'local_preparing',
          );
          continue;
        }
        try {
          w =
            selection.choice.location === 'local'
              ? await createLocalBrowserWorkspace({
                  ...admission,
                  grantId: selection.grantId!,
                  commonIntent: true,
                })
              : await createBrowserWorkspace(admission);
          break;
        } catch (error) {
          if (
            !(error instanceof RuntimePolicyError) ||
            !['local_browser_preparing', 'local_browser_profile_busy'].includes(
              error.code,
            )
          )
            throw error;
          // Retry admission of the same bound call, never a browser action.
          await wait(
            error.code === 'local_browser_preparing'
              ? 'local_preparing'
              : 'local_busy',
          );
        }
      }
      if (waiting) await observer.observe({ stage: 'completed' });
    } catch (error) {
      if (waiting)
        await observer
          .observe({ stage: input.signal?.aborted ? 'canceled' : 'failed' })
          .catch(() => undefined);
      throw error;
    }
    if (w.transport === 'cloud')
      startBrowserWorkspaceController(w, {
        storage: new LocalStorageAdapter(input.storageRoot),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    const until = Date.now() + 20000;
    while (w.acknowledged_fence !== w.control_fence && Date.now() < until) {
      if (input.signal?.aborted) throw Error('BROWSER_CANCELED');
      await delay(100);
      w = await assertOwned(w.id);
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
    await assertOwned(args.workspaceId);
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
    summary: `${op.workspace.transport === 'local' ? '本地' : '云端'}浏览器操作结果已记录`,
    modelContent: JSON.stringify({
      executionChoice: resolveExecutionChoice({
        local: 'ready',
        cloudAvailable: true,
        boundLocation: op.workspace.transport,
      }),
      executionLocation: op.workspace.transport,
      executionReason,
      deviceId: op.workspace.device_id,
      workspaceId: op.workspace.id,
      profileId: op.workspace.profile_id,
      fence: op.workspace.control_fence,
      ...result,
    }),
  };
};
