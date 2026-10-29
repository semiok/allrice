import type { HarnessEvent } from '@allrice/contracts';
import {
  QueueError,
  appendJobEvent,
  completeJob,
  databaseErrorCode,
  failClaimedJobStart,
  failJob,
  finishJobDrain,
  heartbeatJob,
  startClaimedJob,
  type ClaimedExecution,
} from '@allrice/database';

import { HandlerError } from './errors.js';
import {
  beginCheckedFinalDeliveryExecution,
  readCheckedFinalDeliveryForExecution,
} from './final-delivery/checked-delivery.js';
import { HarnessEventBatcher } from './harness/delta-batcher.js';
import { normalizeHarnessRunEvent } from './harness/runtime-contract.js';
import { prepareExecutionIsolation } from './isolation.js';
import { WorkflowPaused } from './workflow-engine.js';
import { NativeQuestionParked } from './harness/dsh/native-question-wait.js';

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

async function joinHeartbeatForCleanup(pending: Promise<void> | undefined) {
  if (!pending) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '40P01'
    ) {
      try {
        await failClaimedJobStart({
          workerId: input.workerId,
          jobId: input.jobId,
          leaseToken: input.leaseToken,
        });
      } catch (settlementError) {
        console.error('[M5] Worker admission deadlock settlement', {
          jobId: input.jobId,
          phase: 'admission',
          sqlState: '40P01',
          settlement: isLeaseLoss(settlementError)
            ? 'lease_lost'
            : 'unconfirmed',
          settlementCode:
            settlementError &&
            typeof settlementError === 'object' &&
            'code' in settlementError &&
            typeof settlementError.code === 'string'
              ? settlementError.code
              : 'unknown',
        });
        if (!isLeaseLoss(settlementError)) throw settlementError;
      }
      return;
    }
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
  let heartbeatTask: Promise<void> | undefined;
  // A heartbeat that lost a lock wait (55P03) retries inside its original lease
  // (MET-210 #4); once this runner returns, no further retry may start.
  const heartbeatRetries = new AbortController();
  const heartbeat = setInterval(() => {
    if (heartbeatTask) return;
    heartbeatTask = heartbeatJob(
      input.workerId,
      input.jobId,
      input.leaseToken,
      input.leaseMs,
      { signal: heartbeatRetries.signal },
    )
      .then((state) => {
        if (!state.active) controller.abort();
      })
      .catch((error: unknown) => {
        // The runner already returned; its cleanup owns what happens next.
        if (heartbeatRetries.signal.aborted) return;
        // Retries are exhausted or the lease is gone: the run cannot continue.
        if (!isLeaseLoss(error)) {
          console.error('[M5] Worker heartbeat failed', {
            jobId: input.jobId,
            sqlState: databaseErrorCode(error),
            message: error instanceof Error ? error.message : 'unknown error',
          });
        }
        controller.abort();
      })
      .finally(() => {
        heartbeatTask = undefined;
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
    const workflowLease = {
      workerId: input.workerId,
      jobId: input.jobId,
      leaseToken: input.leaseToken,
      leaseMs: input.leaseMs,
    };
    beginCheckedFinalDeliveryExecution(workflowLease);
    const result = await executeHandler({
      execution,
      isolation,
      signal: controller.signal,
      onHarnessEvent: (event) => eventBatcher.accept(event),
      workflowLease,
    });
    await eventBatcher.flush();
    if (controller.signal.aborted || input.stopping()) return;
    // Both private proof and its real runtime commit guard are required here.
    // The guard is passed separately; result/event JSON never contains either.
    const delivery = readCheckedFinalDeliveryForExecution(
      workflowLease,
      result,
    );
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
      ...(delivery.coverage !== 'uncovered'
        ? { checkedDelivery: delivery.checkedDelivery }
        : {}),
    });
  } catch (error) {
    if (error instanceof WorkflowPaused) return;
    if (error instanceof NativeQuestionParked && error.persisted) return;
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
    heartbeatRetries.abort();
    // Join the one in-flight heartbeat before releasing its receipt lease.
    const heartbeatJoined = await joinHeartbeatForCleanup(heartbeatTask);
    if (!heartbeatJoined)
      console.error(
        '[M5] Heartbeat join timed out; local cleanup continues, queue maintenance owns terminal state',
        { jobId: input.jobId },
      );
    await eventBatcher.close().catch((error: unknown) => {
      if (!isLeaseLoss(error)) {
        console.error('[M5] Harness event flush failed', {
          jobId: input.jobId,
          message: error instanceof Error ? error.message : 'unknown error',
        });
      }
    });
    try {
      await isolation.cleanup();
    } finally {
      if (heartbeatJoined && controller.signal.aborted && !input.stopping()) {
        try {
          await finishJobDrain({
            workerId: input.workerId,
            jobId: input.jobId,
            leaseToken: input.leaseToken,
          });
        } catch (error) {
          // An expired/replaced incarnation cannot finalize; maintenance owns
          // that boundary. Never restore a lost lease to manufacture closure.
          if (!isLeaseLoss(error))
            console.error(
              '[M5] Receipt drain finalization unconfirmed; queue maintenance retains ownership',
              {
                jobId: input.jobId,
                message:
                  error instanceof Error ? error.message : 'unknown error',
              },
            );
        }
      }
    }
  }
}
