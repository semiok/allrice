import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalStorageAdapter } from '@allrice/storage';
import { verifyStaticBrowser } from '@allrice/browser-control';
import {
  staticBrowserDocumentUrl,
  type BrowserAction,
  type BrowserObservation,
  type BrowserVerificationOutcome,
} from '@allrice/contracts';
import {
  resolveStaticBrowserDocument,
  selectBrowserExecution,
  admitStaticBrowserVerification,
  startStaticBrowserVerification,
  staticBrowserLease,
  recordStaticBrowserContainer,
  readLocalStaticBrowserCapture,
  recordStaticBrowserOutcome,
  publishStaticBrowserVerification,
  browserPrincipal,
  createBrowserOperation,
  requestStaticBrowserStop,
  readCurrentBrowserWorkspace,
  browserStopConfirmed,
  cloudStableId,
  linkTaskOperationCall,
  getDatabase,
  executionResourceObserver,
} from '@allrice/database';
import { CloudRunnerBackend } from '../cloud-runner/backend.js';
import { waitBrowserOperationResult } from './controller.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import type { BrowserWorkspaceToolInputSchema } from './tool-input.js';
import type { z } from 'zod';

type VerifyInput = Extract<
  z.infer<typeof BrowserWorkspaceToolInputSchema>,
  { command: 'verify' }
>;
export async function runStaticBrowserVerification(
  input: RiceToolExecutionInput,
  args: VerifyInput,
) {
  if (
    !input.sessionId ||
    !input.managedBrowserJobAttempt ||
    !input.managedBrowserJobLeaseToken
  )
    throw Error('BROWSER_JOB_LEASE_REQUIRED');
  const storage = new LocalStorageAdapter(input.storageRoot),
    document = await resolveStaticBrowserDocument(
      input.context,
      args.artifact,
      storage,
    );
  const admission = {
    context: input.context,
    callId: input.call.id,
    url: staticBrowserDocumentUrl(document.target),
    jobAttempt: input.managedBrowserJobAttempt,
    jobLeaseToken: input.managedBrowserJobLeaseToken,
    ...(args.location ? { location: args.location } : {}),
    staticArtifact: document.target,
  };
  const observer = executionResourceObserver({
    context: input.context,
    leaseToken: admission.jobLeaseToken,
    attemptId: cloudStableId(
      `static-browser:${input.context.runId}:${input.call.id}`,
    ),
    callId: input.call.id,
  });
  let selection = await selectBrowserExecution(admission);
  while (selection.choice.status === 'wait') {
    await observer.observe({
      stage: 'waiting',
      reason:
        selection.choice.reason === 'local_busy'
          ? 'local_busy'
          : 'local_preparing',
    });
    await delay(500, undefined, { signal: input.signal });
    selection = await selectBrowserExecution(admission);
  }
  if (
    selection.choice.status !== 'execute' ||
    selection.choice.location === 'none'
  )
    throw Error(`STATIC_BROWSER_UNAVAILABLE:${selection.choice.reason}`);
  const row = await admitStaticBrowserVerification({
    context: input.context,
    sessionId: input.sessionId,
    callId: input.call.id,
    target: document.target,
    plan: args.plan,
    jobAttempt: admission.jobAttempt,
    jobLeaseToken: admission.jobLeaseToken,
    location: selection.choice.location,
    reason: selection.selectionReason,
    grantId: selection.grantId,
    grantVersion: selection.grantVersion,
    targetId: selection.targetId,
    deviceId: selection.choice.location === 'local' ? selection.deviceId : null,
    deadlineAt: selection.deadlineAt,
  });
  if (!(await startStaticBrowserVerification(row)))
    throw Error('STATIC_BROWSER_RECONCILIATION_REQUIRED'); // Never repeat an existing click/verification.
  const assertCurrent = async () => {
    input.signal?.throwIfAborted();
    await staticBrowserLease(row);
  };
  const backend = new CloudRunnerBackend(),
    ctx = browserPrincipal(input.context);
  let closed = false;
  const closeLocal = async () => {
    if (!row.browser_workspace_id || closed) return;
    await requestStaticBrowserStop(row);
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      if (
        await browserStopConfirmed(
          input.context,
          row.browser_workspace_id,
          admission.jobAttempt,
          admission.jobLeaseToken,
        )
      ) {
        closed = true;
        return;
      }
      await delay(100);
    }
    throw Error('STATIC_BROWSER_STOP_UNCONFIRMED');
  };
  try {
    let outcome: BrowserVerificationOutcome, screenshot: Buffer;
    if (row.location === 'cloud') {
      const result = await backend.executeStaticBrowser(document, args.plan, {
        attemptId: row.attempt_id,
        deadlineAt: row.deadline_at.toISOString(),
        ...(input.signal ? { signal: input.signal } : {}),
        maintainLease: async () => {
          try {
            await staticBrowserLease(row);
            return true;
          } catch {
            return false;
          }
        },
        onCreated: (id) => recordStaticBrowserContainer(row, id),
        observe: (event) => observer.observe(event),
      });
      if (
        !result.stopped ||
        result.reason !== 'completed' ||
        !result.staticVerification
      )
        throw Error(`STATIC_BROWSER_${result.reason.toUpperCase()}`);
      screenshot = Buffer.from(
        result.staticVerification.screenshotBase64,
        'base64',
      );
      outcome = {
        version: 1,
        verificationId: row.id,
        report: result.staticVerification.report,
        plan: row.plan,
        location: 'cloud',
        executionReason: row.execution_reason,
        targetId: row.target_id,
        deviceId: null,
        attemptId: row.attempt_id,
        containerId: result.containerId,
        imageDigest: result.imageDigest!,
        browserVersion: result.staticVerification.browserVersion,
        physicalStopConfirmed: true,
        screenshotChecksum:
          'sha256:' + createHash('sha256').update(screenshot).digest('hex'),
        screenshotObjectId: null,
        screenshotObservationId:
          result.staticVerification.screenshotObservationId,
      };
    } else {
      const id = row.browser_workspace_id!,
        readyDeadline = Date.now() + 20_000;
      let w = await readCurrentBrowserWorkspace(ctx, id);
      while (
        w.acknowledged_fence !== w.control_fence &&
        Date.now() < readyDeadline
      ) {
        await assertCurrent();
        await delay(100);
        w = await readCurrentBrowserWorkspace(ctx, id);
      }
      if (w.state !== 'agent' || w.acknowledged_fence !== w.control_fence)
        throw Error('BROWSER_CONTROLLER_NOT_READY');
      let sequence = 0,
        latest: BrowserObservation | null = null;
      const perform = async (
        action: BrowserAction,
        observation: BrowserObservation | null,
      ) => {
        await assertCurrent();
        const current = await readCurrentBrowserWorkspace(ctx, id);
        const op = await createBrowserOperation(
          ctx,
          {
            version: 1,
            workspaceId: id,
            profileId: current.profile_id,
            actor: 'agent',
            fence: current.control_fence,
            observationId: observation?.id ?? null,
            action,
          },
          cloudStableId(`static-browser:${row.id}:action:${sequence++}`),
        );
        await linkTaskOperationCall(
          getDatabase(),
          op.snapshot.binding.attempt.operationId,
          input.call.id,
        );
        const result = await waitBrowserOperationResult(
          ctx,
          id,
          op.snapshot.binding.attempt.operationId,
          undefined,
          input.signal,
        );
        if (result.status !== 'succeeded' || !result.observation)
          throw Error('BROWSER_ACTION_UNCONFIRMED');
        latest = result.observation;
      };
      const report = await verifyStaticBrowser({
        target: row.target,
        plan: row.plan,
        assertCurrent,
        perform,
        observe: async () => {
          await perform({ type: 'observe' }, null);
          return latest!;
        },
      });
      await closeLocal();
      const capture = await readLocalStaticBrowserCapture(row, storage);
      screenshot = capture.bytes;
      outcome = {
        version: 1,
        verificationId: row.id,
        report,
        plan: row.plan,
        location: 'local',
        executionReason: row.execution_reason,
        targetId: row.target_id,
        deviceId: row.device_id,
        attemptId: row.attempt_id,
        containerId: null,
        imageDigest: null,
        browserVersion: capture.browserVersion,
        physicalStopConfirmed: true,
        screenshotChecksum: capture.object.checksum,
        screenshotObjectId: capture.object.id,
        screenshotObservationId: (capture.observation as BrowserObservation).id,
      };
    }
    await recordStaticBrowserOutcome(row, outcome);
    const delivery = await publishStaticBrowserVerification(
      row,
      screenshot,
      storage,
    );
    return {
      summary: `页面验证${outcome.report.verdict === 'passed' ? '通过' : outcome.report.verdict === 'failed' ? '未通过' : '未能确认'}`,
      modelContent: JSON.stringify({
        verification: outcome,
        artifacts: [delivery.report, delivery.screenshot],
        notice:
          '这是已保存页面的确定性验证。失败不等于通过；截图与报告已登记，无需重建项目或重复验证。',
      }),
      itemCount: 2,
    };
  } catch (error) {
    await getDatabase()`update allrice_static_browser_verifications set state='unknown'
      where id=${row.id} and job_lease_token=${row.job_lease_token} and state='running'`.catch(
      () => undefined,
    );
    throw error;
  } finally {
    if (row.location === 'cloud') {
      const stopped = await backend.stop(row.attempt_id).catch(() => false);
      if (stopped) await backend.cleanup(row.attempt_id).catch(() => undefined);
    } else await closeLocal().catch(() => undefined); // Bridge's independent lease also stops on authority loss.
  }
}
