import { createHash, randomUUID } from 'node:crypto';

import {
  EmployeeKernelRequestSchema,
  RouteDecisionSchema,
  type HarnessEvent,
  type HarnessExecutionSnapshot,
  type RouteDecision,
} from '@allrice/contracts';

import {
  ConversationRuntimeError,
  QueueError,
  acquireConversationRuntime,
  appendJobEvent,
  bindConversationThread,
  buildExtractiveContextSummary,
  clearConversationTurn,
  claimConversationSteer,
  completeRouteDecision,
  completeJob,
  consumeConversationSteer,
  effectiveContextTokens,
  estimateConversationTokens,
  failJob,
  heartbeatJob,
  getCodexProviderStatus,
  getLatestContextCheckpoint,
  listContextCheckpointEvidence,
  recordConversationTurn,
  recordConversationUsage,
  recordRouteDecision,
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
import { HarnessEventBatcher } from './harness/delta-batcher.js';
import { getHarnessRouter } from './harness/router.js';
import { decideCapabilityRoute } from './routing/capability-router.js';
import {
  executeRiceTool,
  riceToolCapability,
  riceToolDefinitionsForCapabilities,
} from './tool-broker.js';

function providerName(snapshot: HarnessExecutionSnapshot) {
  return snapshot.provider === 'codex' ? 'codex' : snapshot.route;
}

function replayProviderSnapshot(input: {
  decision: RouteDecision;
  original: HarnessExecutionSnapshot;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}): HarnessExecutionSnapshot {
  if (input.decision.harness === 'codex') {
    return {
      provider: 'codex',
      authMode: 'chatgpt_subscription',
      model: input.decision.model,
      reasoningEffort:
        input.reasoningEffort === 'none' ? 'low' : input.reasoningEffort,
      sandbox: 'workspace-write',
    };
  }
  if (input.original.provider !== 'dsh') {
    throw new HandlerError(
      'ROUTE_REPLAY_INVALID',
      'Stored DSH route cannot be reconstructed from this execution snapshot',
      false,
    );
  }
  return { ...input.original, model: input.decision.model };
}

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
    let routeDecision: RouteDecision | null = null;
    let routeUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    };
    try {
      const executionSnapshot = resolved.executionSnapshot;
      if (!executionSnapshot) {
        throw new HandlerError(
          'EMPLOYEE_SNAPSHOT_REQUIRED',
          'Capability routing requires a frozen employee execution snapshot',
          false,
        );
      }
      const allowedToolNames =
        executionSnapshot.employee.definition.schemaVersion === 2
          ? executionSnapshot.employee.definition.capabilityBindings.toolNames
          : undefined;
      const authorizedTools = riceToolDefinitionsForCapabilities(
        resolved.grantedCapabilities,
        allowedToolNames,
      );
      const routePlan = decideCapabilityRoute({
        request: {
          schemaVersion: 1,
          runId: execution.context.runId,
          organizationId: execution.context.organizationId,
          workspaceId: execution.context.workspaceId!,
          actorId: executionSnapshot.tenantContext.actorId,
          employeeId: executionSnapshot.employee.id,
          generation: runtime.generation,
          attempt: execution.job.attempt,
          prompt: kernel.userRequest,
        },
        executionSnapshot,
        tools: authorizedTools.flatMap((tool) => {
          const requiredCapability = riceToolCapability(tool.name);
          return requiredCapability ? [{ ...tool, requiredCapability }] : [];
        }),
      });
      const codexStatus = await getCodexProviderStatus();
      const selectedHarness = getHarnessRouter().select({
        runtimePolicy: executionSnapshot.runtimePolicy,
        providerSnapshot: resolved.providerSnapshot,
        providerHealth: {
          codex: ['disconnected', 'error'].includes(codexStatus.status)
            ? 'unavailable'
            : 'available',
          dsh: 'available',
        },
      });
      const proposedDecision = RouteDecisionSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        runId: execution.context.runId,
        organizationId: execution.context.organizationId,
        workspaceId: execution.context.workspaceId!,
        actorId: executionSnapshot.tenantContext.actorId,
        employeeId: executionSnapshot.employee.id,
        inputChecksum: `sha256:${createHash('sha256')
          .update(kernel.userRequest)
          .digest('hex')}`,
        candidates: routePlan.candidates,
        selectedKind: routePlan.selectedKind,
        selectedCandidateId: routePlan.selectedCandidateId,
        harness: selectedHarness.adapter.kind,
        provider: providerName(selectedHarness.providerSnapshot),
        model: selectedHarness.providerSnapshot.model,
        generation: runtime.generation,
        attempt: execution.job.attempt,
        reasonCodes: [
          ...new Set([...routePlan.reasonCodes, selectedHarness.reasonCode]),
        ],
        createdAt: new Date().toISOString(),
      });
      routeDecision = await recordRouteDecision(proposedDecision);
      if (
        routeDecision.inputChecksum !== proposedDecision.inputChecksum ||
        routeDecision.employeeId !== proposedDecision.employeeId
      ) {
        throw new HandlerError(
          'ROUTE_REPLAY_CONFLICT',
          'Stored routing decision does not match this immutable run input',
          false,
        );
      }
      const selectedCandidate = routeDecision.candidates.find(
        (candidate) => candidate.id === routeDecision!.selectedCandidateId,
      );
      if (!selectedCandidate?.authorized) {
        throw new HandlerError(
          'ROUTE_NOT_AUTHORIZED',
          'Stored routing decision is no longer executable',
          false,
        );
      }
      const providerSnapshot = replayProviderSnapshot({
        decision: routeDecision,
        original: resolved.providerSnapshot,
        reasoningEffort: executionSnapshot.runtimePolicy.reasoningEffort,
      });
      const adapter = getHarnessRouter().resolve(routeDecision.harness);
      if (adapter.isConfigured && !adapter.isConfigured(providerSnapshot)) {
        throw new HandlerError(
          'PROVIDER_UNAVAILABLE',
          'Stored harness route is unavailable in this deployment',
          true,
        );
      }
      const revisionId = routeDecision.selectedCandidateId
        .split(':')
        .slice(1)
        .join(':');
      const selectedSkillVersionIds =
        routeDecision.selectedKind === 'agent_skill' ? [revisionId] : [];
      const skillRequiredTools =
        routeDecision.selectedKind === 'agent_skill' &&
        executionSnapshot.schemaVersion === 2
          ? (executionSnapshot.capabilitySnapshot.agentSkills.find(
              (binding) => binding.revision.id === revisionId,
            )?.revision.metadata.requiredToolRefs ?? [])
          : [];
      const selectedToolNames =
        routeDecision.selectedKind === 'tool'
          ? [revisionId]
          : skillRequiredTools;
      const tools = authorizedTools.filter((tool) =>
        selectedToolNames.includes(tool.name),
      );
      const selectedStorageObjects = resolved.skillArtifacts
        .filter((artifact) =>
          selectedSkillVersionIds.includes(artifact.skillVersionId),
        )
        .map((artifact) => artifact.storageObject);
      const routedKernel = EmployeeKernelRequestSchema.parse({
        ...kernel,
        harness: routeDecision.harness,
        systemInstructions: [
          kernel.systemInstructions,
          `AllRice authorized route for this turn: ${routeDecision.selectedKind} (${routeDecision.selectedCandidateId}). Use only the capabilities and tools supplied for this turn.`,
        ].join('\n\n'),
        grantedCapabilities: [
          ...new Set([
            'model:invoke' as const,
            ...selectedCandidate.requiredCapabilities,
          ]),
        ].filter((capability) =>
          resolved.grantedCapabilities.includes(capability),
        ),
        skillVersionIds: selectedSkillVersionIds,
      });
      let steerPolling = true;
      let steerLoop: Promise<void> | undefined;
      const result = await adapter
        .execute({
          kernel: routedKernel,
          storageObjects: selectedStorageObjects,
          workDirectory: isolation.workDirectory,
          executionEnvironment: isolation.environment,
          providerSnapshot,
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
                  skillVersionIds: resolved.skillArtifacts
                    .map((artifact) => artifact.skillVersionId)
                    .filter((skillVersionId) =>
                      selectedSkillVersionIds.includes(skillVersionId),
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
                    skillVersionIds: resolved.skillArtifacts
                      .map((artifact) => artifact.skillVersionId)
                      .filter((skillVersionId) =>
                        selectedSkillVersionIds.includes(skillVersionId),
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
      routeUsage = result.usage;
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
      await completeRouteDecision({
        organizationId: execution.context.organizationId,
        workspaceId: execution.context.workspaceId!,
        outcome: {
          decisionId: routeDecision.id,
          status: 'succeeded',
          ...routeUsage,
          costCents: 0,
          errorCode: null,
          completedAt: new Date().toISOString(),
        },
      });
      outcome = 'idle';
      return result;
    } catch (error) {
      outcome = signal.aborted ? 'interrupted' : 'error';
      errorCode =
        error instanceof HandlerError ? error.code : 'CONVERSATION_FAILED';
      if (routeDecision) {
        const decision = routeDecision;
        await completeRouteDecision({
          organizationId: execution.context.organizationId,
          workspaceId: execution.context.workspaceId!,
          outcome: {
            decisionId: decision.id,
            status: signal.aborted ? 'canceled' : 'failed',
            ...routeUsage,
            costCents: 0,
            errorCode,
            completedAt: new Date().toISOString(),
          },
        }).catch((outcomeError: unknown) => {
          console.error('[M5] Route outcome persistence failed', {
            runId: execution.context.runId,
            routeDecisionId: decision.id,
            message:
              outcomeError instanceof Error
                ? outcomeError.message
                : 'unknown error',
          });
        });
      }
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
