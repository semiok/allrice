import {
  QueueError,
  appendJobEvent,
  completeJob,
  failJob,
  heartbeatJob,
  resolveEmployeeExecution,
  resolveSkillExecution,
  startClaimedJob,
  type ClaimedExecution,
} from '@allrice/database';

import { prepareExecutionIsolation } from './isolation.js';
import {
  executeCodexHarness,
  executeCodexSkill,
  type NormalizedCodexEvent,
} from './codex.js';
import { HandlerError } from './errors.js';
import { executeRiceTool, riceToolDefinitions } from './tool-broker.js';

function objectInput(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

async function delayWithAbort(milliseconds: number, signal: AbortSignal) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (signal.aborted)
      throw new HandlerError('EXECUTION_ABORTED', 'Execution aborted', false);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(200, Math.max(1, end - Date.now()))),
    );
  }
}

async function executeHandler(
  execution: ClaimedExecution,
  isolation: Awaited<ReturnType<typeof prepareExecutionIsolation>>,
  signal: AbortSignal,
  onCodexEvent: (event: NormalizedCodexEvent) => Promise<void>,
) {
  if (execution.payload.type === 'allrice.employee.run') {
    const input = objectInput(execution.payload.input);
    if (
      typeof input.employeeAssignmentId !== 'string' ||
      typeof input.employeeVersionId !== 'string' ||
      typeof input.sessionId !== 'string' ||
      typeof input.userMessageId !== 'string' ||
      typeof input.assistantMessageId !== 'string'
    ) {
      throw new HandlerError(
        'EMPLOYEE_INPUT_INVALID',
        'Employee execution input is invalid',
        false,
      );
    }
    const resolved = await resolveEmployeeExecution({
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      ownerId: execution.job.ownerId,
      runId: execution.context.runId,
    });
    const conversation = resolved.promptSnapshot.conversation
      .map((message) => `${message.role}: ${message.text}`)
      .join('\n');
    const memories = resolved.promptSnapshot.memories
      .map((memory) => `- [${memory.id}] ${memory.content}`)
      .join('\n');
    return executeCodexHarness({
      storageObjects: resolved.skillArtifacts.map(
        (artifact) => artifact.storageObject,
      ),
      workDirectory: isolation.workDirectory,
      executionEnvironment: isolation.environment,
      systemInstructions: [
        resolved.promptSnapshot.systemPrompt,
        '',
        'Conversation snapshot:',
        conversation || '(new conversation)',
        '',
        'Authorized memory snapshot:',
        memories || '(no matching memories)',
      ].join('\n'),
      prompt: resolved.promptSnapshot.userRequest,
      providerSnapshot: resolved.providerSnapshot,
      grantedCapabilities: resolved.grantedCapabilities,
      signal,
      onEvent: onCodexEvent,
      toolDefinitions: resolved.grantedCapabilities.includes('storage:read')
        ? riceToolDefinitions
        : [],
      onToolCall: resolved.grantedCapabilities.includes('storage:read')
        ? (call) =>
            executeRiceTool({
              context: execution.context,
              capabilities: resolved.grantedCapabilities,
              storageRoot: process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
              call,
            })
        : undefined,
    });
  }
  if (execution.payload.type === 'allrice.skill.run') {
    const input = objectInput(execution.payload.input);
    if (
      typeof input.installationId !== 'string' ||
      typeof input.skillVersionId !== 'string' ||
      typeof input.prompt !== 'string'
    ) {
      throw new HandlerError(
        'SKILL_INPUT_INVALID',
        'Skill execution input is invalid',
        false,
      );
    }
    const resolved = await resolveSkillExecution({
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      ownerId: execution.job.ownerId,
      runId: execution.context.runId,
      installationId: input.installationId,
      skillVersionId: input.skillVersionId,
    });
    return executeCodexSkill({
      storageObject: resolved.storageObject,
      workDirectory: isolation.workDirectory,
      executionEnvironment: isolation.environment,
      prompt: input.prompt,
      providerSnapshot: resolved.providerSnapshot,
      grantedCapabilities: resolved.grantedCapabilities,
      signal,
      onEvent: onCodexEvent,
    });
  }
  if (execution.payload.type !== 'allrice.system.echo') {
    throw new HandlerError(
      'UNSUPPORTED_JOB_TYPE',
      `No Worker handler is registered for ${execution.payload.type}`,
      false,
    );
  }
  const input = objectInput(execution.payload.input);
  const delayMs = boundedInteger(input.delayMs, 0, 0, 30_000);
  const failUntilAttempt = boundedInteger(input.failUntilAttempt, 0, 0, 10);
  await delayWithAbort(delayMs, signal);
  if (execution.job.attempt <= failUntilAttempt) {
    throw new HandlerError(
      'ECHO_RETRY_REQUESTED',
      'The echo acceptance handler requested a retry',
      true,
    );
  }
  return {
    echo: Object.hasOwn(input, 'value') ? input.value : execution.payload.input,
    attempt: execution.job.attempt,
    isolated: true,
  };
}

function isLeaseLoss(error: unknown) {
  return error instanceof QueueError && error.code === 'lease_lost';
}

export async function executeClaimedJob(input: {
  workerId: string;
  jobId: string;
  leaseToken: string;
  leaseMs: number;
  heartbeatMs: number;
  executionRoot: string;
  stopping: () => boolean;
  onAbortReady: (abort: () => void) => void;
}) {
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
    const result = await executeHandler(
      execution,
      isolation,
      controller.signal,
      async (event) => {
        const type =
          event.kind === 'message'
            ? 'assistant.text.completed'
            : event.kind === 'usage'
              ? 'heartbeat'
              : event.status === 'started'
                ? 'tool.started'
                : event.status === 'failed'
                  ? 'tool.failed'
                  : 'tool.completed';
        await appendJobEvent({
          workerId: input.workerId,
          jobId: input.jobId,
          leaseToken: input.leaseToken,
          type,
          payload:
            event.kind === 'message'
              ? { source: 'codex', text: event.text ?? '' }
              : event.kind === 'usage'
                ? { source: 'codex', usage: event.usage }
                : {
                    source: event.source ?? 'codex',
                    toolCallId: event.toolCallId ?? `${event.name}-unknown`,
                    name: event.name ?? 'unknown',
                    label: event.label ?? event.name ?? '工具调用',
                    status: event.status,
                    ...(event.summary ? { summary: event.summary } : {}),
                    ...(event.itemCount === undefined
                      ? {}
                      : { itemCount: event.itemCount }),
                    attempt: execution.job.attempt,
                  },
        });
      },
    );
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
    if (controller.signal.aborted || input.stopping() || isLeaseLoss(error)) {
      return;
    }
    const failure =
      error instanceof HandlerError
        ? error
        : new HandlerError('HANDLER_FAILED', 'Worker handler failed', false);
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
    await isolation.cleanup();
  }
}
