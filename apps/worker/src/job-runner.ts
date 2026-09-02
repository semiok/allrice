import type { HarnessEvent } from '@allrice/contracts';
import {
  QueueError,
  appendJobEvent,
  completeJob,
  failJob,
  heartbeatJob,
  startClaimedJob,
  type ClaimedExecution,
} from '@allrice/database';

import { HandlerError } from './errors.js';
import { HarnessEventBatcher } from './harness/delta-batcher.js';
import { normalizeHarnessRunEvent } from './harness/runtime-contract.js';
import { prepareExecutionIsolation } from './isolation.js';
import { WorkflowPaused } from './workflow-engine.js';

export interface ClaimedJobRunnerInput {
  workerId: string;
  jobId: string;
  leaseToken: string;
  leaseMs: number;
  heartbeatMs: number;
  executionRoot: string;
  stopping: () => boolean;
  onAbortReady: (abort: () => void) => void;
}

export interface ClaimedJobHandlerInput {
  execution: ClaimedExecution;
  isolation: Awaited<ReturnType<typeof prepareExecutionIsolation>>;
  signal: AbortSignal;
  onHarnessEvent: (event: HarnessEvent) => Promise<void>;
  workflowLease: {
    workerId: string;
    jobId: string;
    leaseToken: string;
    leaseMs: number;
  };
}

export type ClaimedJobHandler = (
  input: ClaimedJobHandlerInput,
) => Promise<unknown>;

function isLeaseLoss(error: unknown) {
  return error instanceof QueueError && error.code === 'lease_lost';
}

async function appendHarnessEvent(input: {
  workerId: string;
  jobId: string;
  leaseToken: string;
  event: HarnessEvent;
}) {
  const normalized = normalizeHarnessRunEvent(input.event);
  await appendJobEvent({
    workerId: input.workerId,
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    type: normalized.type,
    payload: normalized.payload,
  });
}

export async function runClaimedJob(
  input: ClaimedJobRunnerInput,
  executeHandler: ClaimedJobHandler,
) {
  let execution: ClaimedExecution | null;
  try {
    execution = await startClaimedJob(
      input.workerId,
      input.jobId,
      input.leaseToken,
    );
  } catch (error) {
    if (error instanceof QueueError && error.code === 'policy_denied') return;
    if (isLeaseLoss(error)) return;
    throw error;
  }
  if (!execution) return;
  if (input.stopping()) return;

  const controller = new AbortController();
  input.onAbortReady(() => controller.abort());
  let isolation;
  try {
    isolation = await prepareExecutionIsolation({
      root: input.executionRoot,
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      ownerId: execution.job.ownerId,
      runId: execution.context.runId,
      jobId: execution.job.id,
      attempt: execution.job.attempt,
    });
  } catch {
    await failJob({
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      code: 'ISOLATION_SETUP_FAILED',
      message: 'Execution isolation could not be prepared',
      retryable: false,
    });
    return;
  }
  const heartbeat = setInterval(() => {
    void heartbeatJob(
      input.workerId,
      input.jobId,
      input.leaseToken,
      input.leaseMs,
    )
      .then((state) => {
        if (!state.active) controller.abort();
      })
      .catch((error: unknown) => {
        if (!isLeaseLoss(error)) {
          console.error('[M5] Worker heartbeat failed', {
            jobId: input.jobId,
            message: error instanceof Error ? error.message : 'unknown error',
          });
        }
        controller.abort();
      });
  }, input.heartbeatMs);

  const eventBatcher = new HarnessEventBatcher((event) =>
    appendHarnessEvent({
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      event,
    }),
  );

  try {
    await appendJobEvent({
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      type: 'step.started',
      payload: {
        handler: execution.payload.type,
        attempt: execution.job.attempt,
        isolation: 'tenant-run-attempt',
      },
    });
    const result = await executeHandler({
      execution,
      isolation,
      signal: controller.signal,
      onHarnessEvent: (event) => eventBatcher.accept(event),
      workflowLease: {
        workerId: input.workerId,
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        leaseMs: input.leaseMs,
      },
    });
    await eventBatcher.flush();
    if (controller.signal.aborted || input.stopping()) return;
    await appendJobEvent({
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      type: 'step.completed',
      payload: { outcome: 'succeeded', attempt: execution.job.attempt },
    });
    await completeJob({
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      result,
    });
  } catch (error) {
    if (error instanceof WorkflowPaused) return;
    if (controller.signal.aborted || input.stopping() || isLeaseLoss(error)) {
      return;
    }
    const failure =
      error instanceof HandlerError
        ? error
        : new HandlerError('HANDLER_FAILED', 'Worker handler failed', false);
    console.error('[M5] Handler failed', {
      jobId: input.jobId,
      code: failure.code,
      message: failure.message,
      cause: error instanceof Error ? error.message : 'unknown error',
    });
    try {
      await failJob({
        workerId: input.workerId,
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      });
    } catch (finalizeError) {
      if (!isLeaseLoss(finalizeError)) throw finalizeError;
    }
  } finally {
    clearInterval(heartbeat);
    await eventBatcher.close().catch((error: unknown) => {
      if (!isLeaseLoss(error)) {
        console.error('[M5] Harness event flush failed', {
          jobId: input.jobId,
          message: error instanceof Error ? error.message : 'unknown error',
        });
      }
    });
    await isolation.cleanup();
  }
}
