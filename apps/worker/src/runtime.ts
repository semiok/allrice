import { createHash } from 'node:crypto';

import {
  ConversationRuntimeError,
  QueueError,
  acquireConversationRuntime,
  appendJobEvent,
  bindConversationThread,
  buildExtractiveContextSummary,
  clearConversationTurn,
  claimConversationSteer,
  completeJob,
  consumeConversationSteer,
  effectiveContextTokens,
  estimateConversationTokens,
  failJob,
  heartbeatJob,
  getLatestContextCheckpoint,
  listContextCheckpointEvidence,
  recordConversationTurn,
  recordConversationUsage,
  recordToolBrokerAudit,
  rejectConversationSteer,
  releaseConversationRuntime,
  resolveEmployeeExecution,
  resolveSkillExecution,
  saveContextCheckpoint,
  shouldCreateContextCheckpoint,
  startClaimedJob,
  type ClaimedExecution,
} from '@allrice/database';

import { prepareExecutionIsolation } from './isolation.js';
import { executeCodexSkill } from './codex.js';
import { assembleEmployeeKernel } from './employee-kernel.js';
import { HandlerError } from './errors.js';
import type { HarnessEvent } from '@allrice/contracts';
import { HarnessEventBatcher } from './harness/delta-batcher.js';
import { getHarnessRouter } from './harness/router.js';
import {
  executeRiceTool,
  riceToolDefinitionsForCapabilities,
} from './tool-broker.js';

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

function contextCompactThreshold() {
  return boundedInteger(
    Number(process.env.ALLRICE_CONTEXT_COMPACT_TOKENS ?? 40_000),
    40_000,
    1_000,
    1_000_000,
  );
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
  onHarnessEvent: (event: HarnessEvent) => Promise<void>,
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
    const configChecksum = `sha256:${createHash('sha256')
      .update(
        JSON.stringify({
          employeeVersionId: input.employeeVersionId,
          provider: resolved.providerSnapshot,
          systemPrompt: resolved.promptSnapshot.systemPrompt,
          skills: resolved.skillArtifacts
            .map((artifact) => artifact.skillVersionId)
            .sort(),
          capabilities: [...resolved.grantedCapabilities].sort(),
        }),
      )
      .digest('hex')}`;
    const checkpoint = await getLatestContextCheckpoint({
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      sessionId: input.sessionId,
      ownerId: execution.job.ownerId,
      configChecksum,
    });
    const kernelInput = {
      employeeAssignmentId: input.employeeAssignmentId,
      employeeVersionId: input.employeeVersionId,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      resolved,
    };
    const kernel = assembleEmployeeKernel({ ...kernelInput, checkpoint });
    const ownership = {
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      sessionId: input.sessionId,
      runId: execution.context.runId,
      workerId: execution.context.worker.id,
    };
    let runtime;
    try {
      runtime = await acquireConversationRuntime({
        ...ownership,
        ownerId: execution.job.ownerId,
        configChecksum,
        compactThresholdTokens: contextCompactThreshold(),
      });
    } catch (error) {
      if (
        error instanceof ConversationRuntimeError &&
        error.code === 'conversation_busy'
      ) {
        throw new HandlerError(
          'CONVERSATION_BUSY',
          'Another Rice turn is still active for this conversation',
          true,
        );
      }
      throw error;
    }
    let outcome: 'idle' | 'interrupted' | 'error' = 'error';
    let errorCode: string | undefined;
    try {
      const tools = riceToolDefinitionsForCapabilities(
        resolved.grantedCapabilities,
      );
      const adapter = getHarnessRouter().resolve(kernel.harness);
      let steerPolling = true;
      let steerLoop: Promise<void> | undefined;
      const result = await adapter
        .execute({
          kernel,
          storageObjects: resolved.skillArtifacts.map(
            (artifact) => artifact.storageObject,
          ),
          workDirectory: isolation.workDirectory,
          executionEnvironment: isolation.environment,
          providerSnapshot: resolved.providerSnapshot,
          signal,
          attempt: execution.job.attempt,
          generation: runtime.generation,
          onEvent: async (event) => {
            if (
              event.type === 'tool.completed' &&
              event.source === 'harness' &&
              (event.name === 'web.search' || event.name === 'web.fetch')
            ) {
              await recordToolBrokerAudit({
                context: execution.context,
                toolName: event.name,
                metadata: {
                  skillVersionIds: resolved.skillArtifacts.map(
                    (artifact) => artifact.skillVersionId,
                  ),
                  capability: 'network:outbound',
                },
              });
            }
            await onHarnessEvent(event);
          },
          tools,
          onToolCall:
            tools.length > 0
              ? (call) =>
                  executeRiceTool({
                    context: execution.context,
                    capabilities: resolved.grantedCapabilities,
                    storageRoot:
                      process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
                    skillVersionIds: resolved.skillArtifacts.map(
                      (artifact) => artifact.skillVersionId,
                    ),
                    sessionId:
                      typeof input.sessionId === 'string'
                        ? input.sessionId
                        : undefined,
                    call,
                  })
              : undefined,
          threadId: runtime.threadId,
          onThreadBound: async ({ threadId }) => {
            runtime = await bindConversationThread({
              ...ownership,
              threadId,
            });
            return { generation: runtime.generation };
          },
          onTurnStarted: async ({ threadId, turnId }) => {
            runtime = await recordConversationTurn({
              ...ownership,
              threadId,
              turnId,
            });
            steerLoop = (async () => {
              while (steerPolling && !signal.aborted) {
                const command = await claimConversationSteer({
                  organizationId: ownership.organizationId,
                  workspaceId: ownership.workspaceId,
                  sessionId: ownership.sessionId,
                  workerId: ownership.workerId,
                  generation: runtime.generation,
                  turnId,
                });
                if (!command) {
                  await new Promise((resolve) => setTimeout(resolve, 150));
                  continue;
                }
                if (!adapter.capabilities.steer || !adapter.steer) {
                  await rejectConversationSteer({
                    commandId: command.id,
                    workerId: ownership.workerId,
                    errorCode: 'HARNESS_STEER_UNSUPPORTED',
                  });
                  continue;
                }
                try {
                  await adapter.steer({
                    threadId,
                    turnId,
                    message: command.message,
                    clientUserMessageId: command.clientUserMessageId,
                  });
                  await consumeConversationSteer({
                    commandId: command.id,
                    workerId: ownership.workerId,
                  });
                } catch (error) {
                  await rejectConversationSteer({
                    commandId: command.id,
                    workerId: ownership.workerId,
                    errorCode: 'STEER_REJECTED',
                  });
                  console.error('[M5] Active turn steer failed', {
                    sessionId: input.sessionId,
                    turnId,
                    message:
                      error instanceof Error ? error.message : 'unknown error',
                  });
                }
              }
            })();
          },
        })
        .finally(async () => {
          steerPolling = false;
          await steerLoop?.catch((error) => {
            console.error('[M5] Active turn steer polling failed', {
              sessionId: input.sessionId,
              message: error instanceof Error ? error.message : 'unknown error',
            });
          });
        });
      runtime = await clearConversationTurn(ownership);
      const checkpointMessages = resolved.promptSnapshot.conversation.flatMap(
        (message) =>
          message.id
            ? [{ id: message.id, role: message.role, text: message.text }]
            : [],
      );
      const applicationEstimatedTokens = estimateConversationTokens(
        [
          kernel.bootstrapConversation,
          kernel.authorizedMemoryContext,
          kernel.userRequest,
        ].join('\n'),
      );
      if (result.usage.inputTokens > 0) {
        runtime = await recordConversationUsage({
          ...ownership,
          generation: runtime.generation,
          inputTokens: result.usage.inputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          applicationEstimatedTokens,
        });
      }
      const coveredThroughMessageId = checkpointMessages.at(-1)?.id ?? null;
      const estimatedTokens =
        result.usage.inputTokens > 0
          ? runtime.contextPressureTokens
          : effectiveContextTokens({
              applicationEstimatedTokens,
              observedDynamicTokens: runtime.dynamicContextTokens,
            });
      if (
        runtime.threadId &&
        adapter.capabilities.compact &&
        adapter.compact &&
        shouldCreateContextCheckpoint({
          estimatedTokens,
          thresholdTokens: runtime.compactThresholdTokens,
          coveredThroughMessageId,
          latestCoveredThroughMessageId:
            checkpoint?.coveredThroughMessageId ?? null,
        })
      ) {
        try {
          await adapter.compact({ threadId: runtime.threadId });
          const evidence = await listContextCheckpointEvidence({
            organizationId: execution.context.organizationId,
            workspaceId: execution.context.workspaceId!,
            sessionId: input.sessionId,
            ownerId: execution.job.ownerId,
          });
          const summary = buildExtractiveContextSummary({
            previousSummary: checkpoint?.summary,
            messages: [...evidence, ...checkpointMessages],
          });
          await saveContextCheckpoint({
            ...ownership,
            ownerId: execution.job.ownerId,
            harness: kernel.harness,
            threadId: runtime.threadId,
            generation: runtime.generation,
            coveredThroughMessageId: coveredThroughMessageId!,
            summary,
            configChecksum,
            estimatedTokens,
            messageCount: checkpointMessages.length,
          });
        } catch (error) {
          console.error('[M5] Context checkpoint maintenance failed', {
            sessionId: input.sessionId,
            runId: execution.context.runId,
            message: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
      outcome = 'idle';
      return result;
    } catch (error) {
      outcome = signal.aborted ? 'interrupted' : 'error';
      errorCode =
        error instanceof HandlerError ? error.code : 'CONVERSATION_FAILED';
      throw error;
    } finally {
      try {
        await releaseConversationRuntime({
          ...ownership,
          outcome,
          ...(errorCode ? { errorCode } : {}),
        });
      } catch (error) {
        if (!(
          error instanceof ConversationRuntimeError &&
          error.code === 'conversation_ownership_lost'
        )) {
          console.error('[M5] Conversation runtime release failed', {
            sessionId: input.sessionId,
            runId: execution.context.runId,
            message: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
    }
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
      onEvent: async (event) => {
        const type =
          event.kind === 'message'
            ? 'assistant.completed'
            : event.kind === 'usage'
              ? 'usage.updated'
              : event.status === 'started'
                ? 'tool.started'
                : event.status === 'failed'
                  ? 'tool.failed'
                  : 'tool.completed';
        await onHarnessEvent({
          schemaVersion: 1,
          harness: 'codex',
          generation: 0,
          attempt: execution.job.attempt,
          order: 1,
          threadId: null,
          turnId: null,
          messageId: execution.context.runId,
          ...(event.kind === 'message'
            ? { type, text: event.text ?? '' }
            : event.kind === 'usage'
              ? {
                  type,
                  inputTokens: event.usage?.inputTokens ?? 0,
                  cachedInputTokens: event.usage?.cachedInputTokens ?? 0,
                  outputTokens: event.usage?.outputTokens ?? 0,
                }
              : {
                  type,
                  toolCallId: event.toolCallId ?? `${event.name}-unknown`,
                  name: event.name ?? 'unknown',
                  label: event.label ?? event.name ?? '工具调用',
                  source:
                    event.source === 'tool_broker' ? 'tool_broker' : 'harness',
                  ...(event.summary ? { summary: event.summary } : {}),
                  ...(event.itemCount === undefined
                    ? {}
                    : { itemCount: event.itemCount }),
                }),
        } as HarnessEvent);
      },
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

async function appendHarnessEvent(input: {
  workerId: string;
  jobId: string;
  leaseToken: string;
  event: HarnessEvent;
}) {
  const { event } = input;
  const type =
    event.type === 'assistant.completed'
      ? 'assistant.text.completed'
      : event.type === 'assistant.delta'
        ? 'assistant.text.delta'
        : event.type === 'usage.updated'
          ? 'heartbeat'
          : event.type === 'tool.started'
            ? 'tool.started'
            : event.type === 'tool.failed'
              ? 'tool.failed'
              : 'tool.completed';
  await appendJobEvent({
    workerId: input.workerId,
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    type,
    payload:
      event.type === 'assistant.completed' || event.type === 'assistant.delta'
        ? {
            source: event.harness,
            text: event.text,
            generation: event.generation,
            turnId: event.turnId,
            messageId: event.messageId,
            attempt: event.attempt,
            order: event.order,
            ...(event.type === 'assistant.delta' && event.orderStart
              ? { orderStart: event.orderStart }
              : {}),
          }
        : event.type === 'usage.updated'
          ? {
              source: event.harness,
              generation: event.generation,
              turnId: event.turnId,
              messageId: event.messageId,
              attempt: event.attempt,
              order: event.order,
              usage: {
                inputTokens: event.inputTokens,
                cachedInputTokens: event.cachedInputTokens,
                outputTokens: event.outputTokens,
              },
            }
          : {
              source:
                event.source === 'tool_broker' ? 'tool_broker' : event.harness,
              toolCallId: event.toolCallId,
              name: event.name,
              label: event.label,
              status: event.type.split('.')[1],
              generation: event.generation,
              turnId: event.turnId,
              messageId: event.messageId,
              ...(event.summary ? { summary: event.summary } : {}),
              ...(event.itemCount === undefined
                ? {}
                : { itemCount: event.itemCount }),
              attempt: event.attempt,
              order: event.order,
            },
  });
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
    const result = await executeHandler(
      execution,
      isolation,
      controller.signal,
      (event) => eventBatcher.accept(event),
    );
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
