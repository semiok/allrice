import { createHash, randomUUID } from 'node:crypto';

import {
  modelProviderRuntimeSupported,
  EmployeeKernelRequestSchema,
  RouteDecisionSchema,
  type HarnessEvent,
  type HarnessExecutionSnapshot,
  type RouteDecision,
} from '@allrice/contracts';

import {
  ConversationRuntimeError,
  acquireConversationRuntime,
  admitModelExecution,
  appendJobEvent,
  completeRouteDecision,
  estimateConversationTokens,
  getCodexProviderStatus,
  getLatestContextCheckpoint,
  getModelGovernanceSnapshot,
  listFailedRouteDecisions,
  recordRouteDecision,
  recordToolBrokerAudit,
  ensureWorkflowRunForExecution,
  releaseConversationRuntime,
  resolveEmployeeExecution,
  assertQuotaAvailable,
  ModelGovernanceError,
  assertReviewRunCurrent,
} from '@allrice/database';

import { AgentLoopGuard, AgentLoopGuardError } from '../agent-loop-guard.js';
import { finalizeEmployeeConversationContext } from '../conversation/checkpoint-maintenance.js';
import {
  beginEmployeeConversationTurn,
  bindEmployeeConversationThread,
  pollEmployeeConversationSteers,
} from '../conversation/turn-lifecycle.js';
import { assembleEmployeeKernel } from '../employee-kernel.js';
import { getChangesetRun } from '@allrice/database';
import { executeChangesetRun } from './changeset-run.js';
import { HandlerError } from '../errors.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import {
  classifyProviderFailure,
  failedDecisionRouteKey,
  getHarnessRouter,
  harnessRouteKey,
} from '../harness/router.js';
import { buildAuthorizedKnowledgeContext } from '../knowledge.js';
import { estimateModelCostCents } from '../model-cost.js';
import { decideCapabilityRoute } from '../routing/capability-router.js';
import {
  providerSnapshotForModelTarget,
  replayProviderSnapshot,
} from '../routing/provider-snapshot.js';
import { executeDurableWorkflow, WorkflowPaused } from '../workflow-engine.js';
import { loadHarnessImages } from '../harness/prompt-images.js';
import {
  executeRiceTool,
  riceToolCapability,
  riceToolDefinitionsForCapabilities,
  riceToolDefinitionsForTurn,
  riceToolRisk,
} from '../tool-broker.js';

function providerName(snapshot: HarnessExecutionSnapshot) {
  return snapshot.provider === 'codex' ? 'openai-codex' : snapshot.route;
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

export async function executeEmployeeRun({
  execution,
  isolation,
  signal,
  onHarnessEvent,
  workflowLease,
}: ClaimedJobHandlerInput) {
  if (execution.payload.type !== 'allrice.employee.run') {
    throw new HandlerError(
      'UNSUPPORTED_JOB_TYPE',
      `Employee handler cannot execute ${execution.payload.type}`,
      false,
    );
  }
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
  const userMessageId = input.userMessageId;
  const resolved = await resolveEmployeeExecution({
    organizationId: execution.context.organizationId,
    workspaceId: execution.context.workspaceId!,
    ownerId: execution.job.ownerId,
    runId: execution.context.runId,
  });
  // A queued historical Run may predate the prepareEmployeeRunBinding guard.
  // Keep its record readable, but never reinterpret unsupported OAuth as an API key.
  const primaryModelSnapshot =
    resolved.executionSnapshot?.schemaVersion === 2
      ? resolved.executionSnapshot.modelSnapshot
      : undefined;
  if (
    primaryModelSnapshot &&
    !modelProviderRuntimeSupported({
      key: primaryModelSnapshot.provider,
      authMode: primaryModelSnapshot.authMode,
    })
  )
    throw new HandlerError(
      'PROVIDER_AUTH_UNSUPPORTED',
      'The frozen provider authorization mode has no reviewed execution adapter',
      false,
    );
  try {
    await assertReviewRunCurrent(
      {
        actor: execution.context.delegatedBy,
        organizationId: execution.context.organizationId,
        workspaceId: execution.context.workspaceId,
      },
      input.sessionId,
      execution.context.runId,
    );
  } catch {
    throw new HandlerError(
      'REVIEW_VERSION_CHANGED',
      '修订任务的工件版本或访问权限已变化，请审查当前版本后重新提交。',
      false,
    );
  }
  const configChecksum = `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        employeeVersionId: input.employeeVersionId,
        provider: resolved.providerSnapshot,
        systemPrompt: resolved.promptSnapshot.systemPrompt,
        skills: resolved.nativeSkills
          .map((skill) => `${skill.id}:${skill.checksum}`)
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
  const harnessImages = await loadHarnessImages(kernel.imageAttachments);
  const ownership = {
    organizationId: execution.context.organizationId,
    workspaceId: execution.context.workspaceId!,
    sessionId: input.sessionId,
    runId: execution.context.runId,
    workerId: execution.context.worker.id,
  };
  const appendChatFlowEvent = (
    type:
      | 'session.bound'
      | 'turn.started'
      | 'turn.completed'
      | 'turn.failed'
      | 'turn.canceled'
      | 'routing.selected',
    payload: Record<string, unknown>,
  ) =>
    appendJobEvent({
      ...workflowLease,
      type,
      payload,
    });
  let runtime: Awaited<ReturnType<typeof acquireConversationRuntime>>;
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
  let routeCostCents = 0;
  const loopGuard = new AgentLoopGuard();
  const guardedHarnessEvent = async (event: HarnessEvent) => {
    try {
      loopGuard.observe(event);
    } catch (error) {
      if (error instanceof AgentLoopGuardError) {
        throw new HandlerError(
          error.code,
          'Agent execution was stopped by the loop guard',
          false,
        );
      }
      throw error;
    }
    await onHarnessEvent(event);
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
    if (
      await getChangesetRun(
        {
          actor: execution.context.delegatedBy,
          organizationId: execution.context.organizationId,
          workspaceId: execution.context.workspaceId,
        },
        input.sessionId,
        execution.context.runId,
      )
    ) {
      const result = await executeChangesetRun({
        execution,
        isolation,
        signal,
        onHarnessEvent,
        workflowLease,
      });
      outcome = 'idle';
      return result;
    }
    const capabilitySnapshot =
      executionSnapshot.schemaVersion === 2
        ? executionSnapshot.capabilitySnapshot
        : null;
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
        return requiredCapability && riceToolRisk(tool.name) !== 'read_only'
          ? [{ ...tool, requiredCapability }]
          : [];
      }),
    });
    const codexStatus = await getCodexProviderStatus();
    const frozenModelSnapshot =
      executionSnapshot.schemaVersion === 2
        ? executionSnapshot.modelSnapshot
        : undefined;
    const fallbackSnapshots =
      executionSnapshot.schemaVersion === 2
        ? (executionSnapshot.modelSnapshot?.resolvedFallbacks.map(
            providerSnapshotForModelTarget,
          ) ?? [])
        : [];
    const governance = frozenModelSnapshot
      ? await getModelGovernanceSnapshot({
          organizationId: execution.context.organizationId,
          connectionIds: [
            frozenModelSnapshot.connectionId,
            ...frozenModelSnapshot.resolvedFallbacks.map(
              (target) => target.connectionId,
            ),
          ],
        })
      : null;
    if (governance) {
      try {
        assertQuotaAvailable(governance.quota);
      } catch (error) {
        if (error instanceof ModelGovernanceError) {
          throw new HandlerError(
            error.code,
            error.scope
              ? `The ${error.scope} model resource limit has been reached`
              : 'The organization model quota has been reached',
            false,
          );
        }
        throw error;
      }
    }
    const failedRoutes = await listFailedRouteDecisions({
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      runId: execution.context.runId,
      beforeAttempt: execution.job.attempt,
    });
    const allowedFallbacks = new Set(frozenModelSnapshot?.fallbackOn ?? []);
    const eligibleFailures = failedRoutes.flatMap((failed) => {
      const condition = classifyProviderFailure(failed.errorCode);
      return condition && allowedFallbacks.has(condition)
        ? [{ ...failed, condition }]
        : [];
    });
    const previousFallback = eligibleFailures.at(-1) ?? null;
    const codexUnavailable = ['disconnected', 'error'].includes(
      codexStatus.status,
    );
    const blockedConnections = new Map(
      (governance?.providers ?? [])
        .filter(
          (provider) => provider.killSwitch || provider.circuitState === 'open',
        )
        .map((provider) => [provider.connectionId, provider] as const),
    );
    const governanceExcludedRoutes = [
      ...(frozenModelSnapshot &&
      blockedConnections.has(frozenModelSnapshot.connectionId)
        ? [harnessRouteKey(resolved.providerSnapshot)]
        : []),
      ...(frozenModelSnapshot?.resolvedFallbacks ?? [])
        .filter((target) => blockedConnections.has(target.connectionId))
        .map((target) =>
          harnessRouteKey(providerSnapshotForModelTarget(target)),
        ),
      ...(resolved.providerSnapshot.provider === 'dsh' &&
      resolved.providerSnapshot.route === 'openai-codex' &&
      codexUnavailable
        ? [harnessRouteKey(resolved.providerSnapshot)]
        : []),
    ];
    const primaryGovernance = frozenModelSnapshot
      ? blockedConnections.get(frozenModelSnapshot.connectionId)
      : undefined;
    const primaryUnavailable =
      Boolean(primaryGovernance) ||
      ((resolved.providerSnapshot.provider === 'codex' ||
        (resolved.providerSnapshot.provider === 'dsh' &&
          resolved.providerSnapshot.route === 'openai-codex')) &&
        codexUnavailable);
    const preflightFallbackAllowed =
      !primaryUnavailable || allowedFallbacks.has('provider_unavailable');
    const selectedHarness = getHarnessRouter().select({
      runtimePolicy: executionSnapshot.runtimePolicy,
      providerSnapshot: resolved.providerSnapshot,
      fallbackSnapshots: preflightFallbackAllowed ? fallbackSnapshots : [],
      excludedRoutes: [
        ...eligibleFailures.map(({ decision }) =>
          failedDecisionRouteKey(decision),
        ),
        ...governanceExcludedRoutes,
      ],
      allowRuntimePolicyFallbacks: executionSnapshot.schemaVersion !== 2,
      providerHealth: {
        dsh: 'available',
      },
    });
    const selectedFallback = frozenModelSnapshot?.resolvedFallbacks.find(
      (target) =>
        harnessRouteKey(providerSnapshotForModelTarget(target)) ===
        harnessRouteKey(selectedHarness.providerSnapshot),
    );
    if (frozenModelSnapshot) {
      try {
        // Resource limits and release controls belong to the route that will
        // actually execute. Charging the frozen primary here would make a
        // successful fallback consume the wrong Provider budget.
        await admitModelExecution({
          organizationId: execution.context.organizationId,
          workspaceId: execution.context.workspaceId!,
          userId: executionSnapshot.tenantContext.actorId,
          employeeId: executionSnapshot.employee.id,
          connectionId:
            selectedFallback?.connectionId ?? frozenModelSnapshot.connectionId,
          requestedTokens: frozenModelSnapshot.runLimits.maxTotalTokens,
          requestedRuntimeMs: frozenModelSnapshot.runLimits.timeoutMs,
        });
      } catch (error) {
        if (error instanceof ModelGovernanceError) {
          throw new HandlerError(
            error.code,
            error.scope
              ? `The ${error.scope} model resource limit has been reached`
              : 'The organization model quota has been reached',
            false,
          );
        }
        throw error;
      }
    }
    const fallbackCondition =
      previousFallback?.condition ??
      (selectedHarness.reasonCode === 'fallback_provider_selected' &&
      primaryUnavailable
        ? ('provider_unavailable' as const)
        : null);
    const fallbackReasonCode =
      fallbackCondition === 'provider_unavailable'
        ? ('fallback_condition_provider_unavailable' as const)
        : fallbackCondition === 'rate_limited'
          ? ('fallback_condition_rate_limited' as const)
          : fallbackCondition === 'timeout'
            ? ('fallback_condition_timeout' as const)
            : fallbackCondition === 'transient_error'
              ? ('fallback_condition_transient_error' as const)
              : null;
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
      modelConnectionId:
        selectedFallback?.connectionId ??
        frozenModelSnapshot?.connectionId ??
        null,
      modelCatalogEntryId:
        selectedFallback?.modelCatalogEntryId ??
        frozenModelSnapshot?.modelCatalogEntryId ??
        null,
      modelPolicyRevision: frozenModelSnapshot?.policyRevision ?? null,
      fallbackFromDecisionId: previousFallback?.decision.id ?? null,
      fallbackCondition,
      generation: runtime.generation,
      attempt: execution.job.attempt,
      reasonCodes: [
        ...new Set([
          ...routePlan.reasonCodes,
          selectedHarness.reasonCode,
          ...(fallbackReasonCode ? [fallbackReasonCode] : []),
        ]),
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
    await appendChatFlowEvent('routing.selected', {
      source: routeDecision.harness,
      selectedKind: routeDecision.selectedKind,
      selectedCandidateId: routeDecision.selectedCandidateId,
      provider: routeDecision.provider,
      model: routeDecision.model,
      reasonCodes: routeDecision.reasonCodes,
      fallback: routeDecision.reasonCodes.some((reason) =>
        reason.includes('fallback'),
      ),
      fallbackFromDecisionId: routeDecision.fallbackFromDecisionId,
      fallbackCondition: routeDecision.fallbackCondition,
    });
    const providerSnapshot = replayProviderSnapshot({
      decision: routeDecision,
      original: resolved.providerSnapshot,
      fallbacks: fallbackSnapshots,
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
    const routePlanMatchesStoredDecision =
      routeDecision.selectedCandidateId === routePlan.selectedCandidateId;
    const selectedSkillVersionIds: string[] = [];
    const selectedKnowledgeRevisionIds = routePlanMatchesStoredDecision
      ? routePlan.selectedKnowledgeRevisionIds
      : routeDecision.selectedKind === 'knowledge'
        ? [revisionId]
        : [];
    const selectedWorkflow =
      routeDecision.selectedKind === 'workflow' && capabilitySnapshot
        ? capabilitySnapshot.workflows.find(
            (binding) => binding.revision.id === revisionId,
          )
        : undefined;
    const workflowToolNames =
      selectedWorkflow?.revision.definition.steps.flatMap((step) => {
        const name = step.input.toolName;
        return step.kind === 'tool' && typeof name === 'string' ? [name] : [];
      }) ?? [];
    const selectedToolNames =
      routeDecision.selectedKind === 'tool'
        ? [revisionId]
        : routeDecision.selectedKind === 'workflow'
          ? workflowToolNames
          : [];
    const tools = riceToolDefinitionsForTurn(
      resolved.grantedCapabilities,
      allowedToolNames,
      selectedToolNames,
    );
    const turnToolCapabilities = tools.flatMap((tool) => {
      const capability = riceToolCapability(tool.name);
      return capability ? [capability] : [];
    });
    const selectedStorageObjects: (typeof resolved.skillArtifacts)[number]['storageObject'][] =
      [];
    const knowledge = await buildAuthorizedKnowledgeContext({
      context: execution.context,
      employeeId: executionSnapshot.employee.id,
      knowledgeRevisionIds: selectedKnowledgeRevisionIds,
      query: kernel.userRequest,
      storageRoot: process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
    });
    const routedKernel = EmployeeKernelRequestSchema.parse({
      ...kernel,
      harness: routeDecision.harness,
      systemInstructions: [
        kernel.systemInstructions,
        `Current date: ${new Date().toISOString().slice(0, 10)}. Treat this as the authoritative current date for relative dates such as today, yesterday, and latest. When using web tools, distinguish the retrieval date from dates mentioned inside search results, and cite only source URLs returned by the tool.`,
        `AllRice authorized route for this turn: ${routeDecision.selectedKind} (${routeDecision.selectedCandidateId}). Tenant-authorized read-only tools are supplied as a stable capability set; decide whether to call them using the native DSH Agent Loop. Side-effect tools are available only when explicitly selected. Use only the capabilities and tools supplied for this turn.`,
      ].join('\n\n'),
      authorizedMemoryContext: [
        kernel.authorizedMemoryContext,
        knowledge.context,
      ]
        .filter(Boolean)
        .join('\n\n'),
      grantedCapabilities: [
        ...new Set([
          'model:invoke' as const,
          ...selectedCandidate.requiredCapabilities,
          ...turnToolCapabilities,
        ]),
      ].filter((capability) =>
        resolved.grantedCapabilities.includes(capability),
      ),
      skillVersionIds: selectedSkillVersionIds,
    });
    const runLimits =
      executionSnapshot.schemaVersion === 2
        ? executionSnapshot.modelSnapshot?.runLimits
        : undefined;
    if (runLimits) {
      const estimatedInputTokens = estimateConversationTokens(
        [
          routedKernel.systemInstructions,
          routedKernel.bootstrapConversation,
          routedKernel.authorizedMemoryContext,
          routedKernel.userRequest,
        ].join('\n'),
      );
      if (
        estimatedInputTokens > runLimits.maxInputTokens ||
        estimatedInputTokens > runLimits.maxTotalTokens
      ) {
        throw new HandlerError(
          'MODEL_INPUT_BUDGET_EXCEEDED',
          'Frozen employee model input budget was exceeded',
          false,
        );
      }
    }
    let steerPolling = true;
    let steerLoop: Promise<void> | undefined;
    const workflowCitations: typeof knowledge.citations = [];
    const result =
      routeDecision.selectedKind === 'workflow'
        ? await (async () => {
            if (!selectedWorkflow || !capabilitySnapshot) {
              throw new HandlerError(
                'WORKFLOW_SNAPSHOT_MISSING',
                'Selected workflow is missing from the frozen employee snapshot',
                false,
              );
            }
            await ensureWorkflowRunForExecution({
              context: execution.context,
              ownerId: execution.job.ownerId,
              employeeId: executionSnapshot.employee.id,
              workflowRevisionId: selectedWorkflow.revision.id,
              sessionId: kernel.sessionId,
              value: { request: kernel.userRequest },
            });
            const usage = {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
            };
            const durable = await executeDurableWorkflow({
              execution,
              ...workflowLease,
              storageRoot: process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
              evaluation: {
                routingAccurate: true,
                citationsAccurate: true,
                approvalExpected:
                  selectedWorkflow.revision.definition.steps.some(
                    (step) => step.approval === 'required',
                  ),
              },
              executeStep: async ({ step, value, idempotencyKey }) => {
                if (step.kind === 'knowledge') {
                  const allowed = new Set(
                    capabilitySnapshot.knowledge
                      .filter((binding) => binding.effective)
                      .map((binding) => binding.revision.id),
                  );
                  const configured = step.input.knowledgeRevisionIds;
                  const requested = Array.isArray(configured)
                    ? configured.filter(
                        (item): item is string =>
                          typeof item === 'string' && allowed.has(item),
                      )
                    : [];
                  const revisionIds = requested.length
                    ? requested
                    : [...allowed];
                  const retrieved = await buildAuthorizedKnowledgeContext({
                    context: execution.context,
                    employeeId: executionSnapshot.employee.id,
                    knowledgeRevisionIds: revisionIds,
                    query:
                      typeof step.input.query === 'string'
                        ? step.input.query
                        : kernel.userRequest,
                    storageRoot:
                      process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
                  });
                  workflowCitations.push(...retrieved.citations);
                  return {
                    output: {
                      context: retrieved.context,
                      citations: retrieved.citations,
                    },
                  };
                }
                if (step.kind === 'tool') {
                  const name = step.input.toolName;
                  if (
                    typeof name !== 'string' ||
                    !tools.some((tool) => tool.name === name)
                  ) {
                    throw new HandlerError(
                      'WORKFLOW_TOOL_DENIED',
                      'Workflow tool is not in the frozen authorized tool set',
                      false,
                    );
                  }
                  const configuredArguments = step.input.arguments;
                  const argumentsValue =
                    configuredArguments &&
                    typeof configuredArguments === 'object' &&
                    !Array.isArray(configuredArguments)
                      ? (configuredArguments as Record<string, unknown>)
                      : value;
                  const toolResult = await executeRiceTool({
                    context: execution.context,
                    managedBrowserJobAttempt: execution.job.attempt,
                    managedBrowserJobLeaseToken: workflowLease.leaseToken,
                    capabilities: resolved.grantedCapabilities,
                    storageRoot:
                      process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
                    sessionId: kernel.sessionId,
                    employeeId: executionSnapshot.employee.id,
                    userMessageId,
                    userRequest: kernel.userRequest,
                    signal,
                    call: {
                      id: idempotencyKey,
                      name,
                      arguments: argumentsValue,
                    },
                  });
                  return {
                    output: toolResult,
                    sideEffectCommitted: step.sideEffect !== 'none',
                  };
                }
                if (step.kind !== 'model' && step.kind !== 'agent_skill') {
                  throw new HandlerError(
                    'WORKFLOW_STEP_UNSUPPORTED',
                    `Workflow step ${step.kind} cannot execute directly`,
                    false,
                  );
                }
                const requestedSkillId =
                  step.kind === 'agent_skill' &&
                  typeof step.input.agentSkillRevisionId === 'string'
                    ? step.input.agentSkillRevisionId
                    : null;
                const allowedSkillIds = new Set(
                  resolved.nativeSkills.map((skill) => skill.id),
                );
                if (
                  requestedSkillId &&
                  !allowedSkillIds.has(requestedSkillId)
                ) {
                  throw new HandlerError(
                    'WORKFLOW_SKILL_DENIED',
                    'Workflow skill is not in the frozen authorized skill set',
                    false,
                  );
                }
                const skillIds = requestedSkillId ? [requestedSkillId] : [];
                const stepKernel = EmployeeKernelRequestSchema.parse({
                  ...routedKernel,
                  systemInstructions: [
                    routedKernel.systemInstructions,
                    `Execute only workflow step ${step.key} (${step.name}). Return this step's business result; the Workflow Engine controls progression, approval and retry.`,
                  ].join('\n\n'),
                  userRequest: JSON.stringify(value),
                  authorizedMemoryContext: [
                    routedKernel.authorizedMemoryContext,
                    JSON.stringify(value.dependencies),
                  ]
                    .filter(Boolean)
                    .join('\n\n'),
                  skillVersionIds: skillIds,
                });
                const stepResult = await adapter.execute({
                  kernel: stepKernel,
                  nativeSkills: resolved.nativeSkills,
                  storageObjects: [],
                  images: [],
                  workDirectory: isolation.workDirectory,
                  executionEnvironment: isolation.environment,
                  providerSnapshot,
                  signal,
                  attempt: execution.job.attempt,
                  generation: runtime.generation,
                  maxOutputTokens: runLimits?.maxOutputTokens,
                  onEvent: guardedHarnessEvent,
                  authorizedToolNames: authorizedTools.map((tool) => tool.name),
                  tools: [],
                  threadId: runtime.threadId,
                  onThreadBound: async ({
                    threadId,
                    resumed,
                    replacedThreadId,
                  }) => {
                    runtime = await bindEmployeeConversationThread({
                      ownership,
                      adapterKind: adapter.kind,
                      threadId,
                      resumed,
                      replacedThreadId,
                      appendEvent: appendChatFlowEvent,
                    });
                    return { generation: runtime.generation };
                  },
                  onTurnStarted: async ({ threadId, turnId }) => {
                    runtime = await beginEmployeeConversationTurn({
                      ownership,
                      adapterKind: adapter.kind,
                      threadId,
                      turnId,
                      appendEvent: appendChatFlowEvent,
                    });
                  },
                });
                await appendChatFlowEvent('turn.completed', {
                  source: adapter.kind,
                  threadId: stepResult.threadId ?? runtime.threadId,
                  turnId: stepResult.turnId ?? runtime.activeTurnId,
                  generation: runtime.generation,
                });
                usage.inputTokens += stepResult.usage.inputTokens;
                usage.cachedInputTokens += stepResult.usage.cachedInputTokens;
                usage.outputTokens += stepResult.usage.outputTokens;
                return { output: { answer: stepResult.answer } };
              },
            });
            const answers = Object.values(durable.output).flatMap((value) =>
              value &&
              typeof value === 'object' &&
              typeof (value as { answer?: unknown }).answer === 'string'
                ? [(value as { answer: string }).answer]
                : [],
            );
            return {
              answer:
                answers.at(-1) ??
                `工作流已完成，共执行 ${selectedWorkflow.revision.definition.steps.length} 个步骤。`,
              usage,
              provider: providerName(providerSnapshot),
              model: providerSnapshot.model,
              threadId: runtime.threadId,
              turnId: runtime.activeTurnId,
            };
          })()
        : await adapter
            .execute({
              kernel: routedKernel,
              nativeSkills: resolved.nativeSkills,
              storageObjects: selectedStorageObjects,
              images: harnessImages,
              workDirectory: isolation.workDirectory,
              executionEnvironment: isolation.environment,
              providerSnapshot,
              signal,
              attempt: execution.job.attempt,
              generation: runtime.generation,
              maxOutputTokens: runLimits?.maxOutputTokens,
              onEvent: async (event) => {
                if (
                  event.type === 'tool.completed' &&
                  event.source === 'harness' &&
                  (event.name === 'web.search' ||
                    event.name === 'web.fetch' ||
                    event.name === 'browser.run' ||
                    event.name === 'wechat.article.search' ||
                    event.name === 'wechat.article.read')
                ) {
                  await recordToolBrokerAudit({
                    context: execution.context,
                    toolName: event.name,
                    metadata: {
                      skillVersionIds: resolved.nativeSkills.map(
                        (skill) => skill.id,
                      ),
                      capability: 'network:outbound',
                    },
                  });
                }
                await guardedHarnessEvent(event);
              },
              authorizedToolNames: authorizedTools.map((tool) => tool.name),
              tools,
              onToolCall:
                tools.length > 0
                  ? (call) =>
                      executeRiceTool({
                        context: execution.context,
                        managedBrowserJobAttempt: execution.job.attempt,
                        managedBrowserJobLeaseToken: workflowLease.leaseToken,
                        capabilities: resolved.grantedCapabilities,
                        storageRoot:
                          process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
                        skillVersionIds: resolved.nativeSkills.map(
                          (skill) => skill.id,
                        ),
                        sessionId:
                          typeof input.sessionId === 'string'
                            ? input.sessionId
                            : undefined,
                        employeeId: executionSnapshot.employee.id,
                        userMessageId,
                        userRequest: kernel.userRequest,
                        signal,
                        call,
                      })
                  : undefined,
              threadId: runtime.threadId,
              onThreadBound: async ({
                threadId,
                resumed,
                replacedThreadId,
              }) => {
                runtime = await bindEmployeeConversationThread({
                  ownership,
                  adapterKind: adapter.kind,
                  threadId,
                  resumed,
                  replacedThreadId,
                  appendEvent: appendChatFlowEvent,
                });
                return { generation: runtime.generation };
              },
              onTurnStarted: async ({ threadId, turnId }) => {
                runtime = await beginEmployeeConversationTurn({
                  ownership,
                  adapterKind: adapter.kind,
                  threadId,
                  turnId,
                  appendEvent: appendChatFlowEvent,
                });
                steerLoop = pollEmployeeConversationSteers({
                  ownership,
                  generation: runtime.generation,
                  threadId,
                  turnId,
                  signal,
                  adapter,
                  polling: () => steerPolling,
                });
              },
            })
            .finally(async () => {
              steerPolling = false;
              await steerLoop?.catch((error) => {
                console.error('[M5] Active turn steer polling failed', {
                  sessionId: input.sessionId,
                  message:
                    error instanceof Error ? error.message : 'unknown error',
                });
              });
              if (runtime.threadId && runtime.activeTurnId) {
                await pollEmployeeConversationSteers({
                  ownership,
                  generation: runtime.generation,
                  threadId: runtime.threadId,
                  turnId: runtime.activeTurnId,
                  signal,
                  adapter,
                  polling: () => false,
                  drain: true,
                });
              }
            });
    if (routeDecision.selectedKind !== 'workflow') {
      await appendChatFlowEvent('turn.completed', {
        source: adapter.kind,
        threadId: result.threadId ?? runtime.threadId,
        turnId: result.turnId ?? runtime.activeTurnId,
        generation: runtime.generation,
      });
    }
    routeUsage = result.usage;
    routeCostCents = estimateModelCostCents({
      provider: result.provider,
      model: result.model,
      ...result.usage,
    });
    if (
      runLimits &&
      (result.usage.outputTokens > runLimits.maxOutputTokens ||
        result.usage.inputTokens + result.usage.outputTokens >
          runLimits.maxTotalTokens ||
        (runLimits.maxCostCents !== null &&
          routeCostCents > runLimits.maxCostCents))
    ) {
      throw new HandlerError(
        'MODEL_OUTPUT_BUDGET_EXCEEDED',
        'Frozen employee model output budget was exceeded',
        false,
      );
    }
    const checkpointMessages = resolved.promptSnapshot.conversation.flatMap(
      (message) =>
        message.id
          ? [{ id: message.id, role: message.role, text: message.text }]
          : [],
    );
    runtime = await finalizeEmployeeConversationContext({
      ownership,
      ownerId: execution.job.ownerId,
      executionContext: execution.context,
      employeeId: executionSnapshot.employee.id,
      kernel,
      result,
      adapter,
      checkpoint,
      checkpointMessages,
      configChecksum,
      workflowLease,
    });
    await completeRouteDecision({
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      outcome: {
        decisionId: routeDecision.id,
        status: 'succeeded',
        ...routeUsage,
        costCents: routeCostCents,
        errorCode: null,
        failureCategory: null,
        completedAt: new Date().toISOString(),
      },
    });
    outcome = 'idle';
    return {
      ...result,
      citations: [...knowledge.citations, ...workflowCitations].filter(
        (citation, index, values) =>
          values.findIndex(
            (candidate) =>
              candidate.type === citation.type && candidate.id === citation.id,
          ) === index,
      ),
    };
  } catch (error) {
    if (error instanceof WorkflowPaused) {
      outcome = 'idle';
      throw error;
    }
    outcome = signal.aborted ? 'interrupted' : 'error';
    if (runtime.activeTurnId) {
      await appendChatFlowEvent(
        signal.aborted ? 'turn.canceled' : 'turn.failed',
        {
          source: routeDecision?.harness ?? kernel.harness,
          threadId: runtime.threadId,
          turnId: runtime.activeTurnId,
          generation: runtime.generation,
        },
      ).catch(() => undefined);
    }
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
          costCents: routeCostCents,
          errorCode,
          failureCategory: classifyProviderFailure(errorCode),
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
