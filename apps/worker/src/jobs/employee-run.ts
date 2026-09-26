import { createHash, randomUUID } from 'node:crypto';
import { LocalStorageAdapter } from '@allrice/storage';

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
  getDatabase,
  readWorkAutomation,
  acquireConversationRuntime,
  admitModelExecution,
  assertProviderAvailable,
  appendJobEvent,
  createTaskProgressRuntime,
  completeRouteDecision,
  estimateConversationTokens,
  getCodexProviderStatus,
  getLatestContextCheckpoint,
  getModelGovernanceSnapshot,
  listFailedRouteDecisions,
  recordRouteDecision,
  freezeRouteSubscriptionSnapshot,
  recordToolBrokerAudit,
  ensureWorkflowRunForExecution,
  releaseConversationRuntime,
  resolveEmployeeExecution,
  ModelGovernanceError,
  assertReviewRunCurrent,
  assertAssistantAuthority,
  parkNativeQuestion,
  readNativeQuestionWait,
  continueNativeQuestion,
  claimConversationSteer,
  consumeConversationSteer,
  beginNativeTask,
  completeNativeTask,
  readParkedNativeUsage,
  NativeWaitAuthorityError,
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
import {
  assertInitialModelInputBudget,
  checkCompletedModelBudget,
  modelAdmissionTokenEstimate,
} from '../model-result-budget.js';
import { assertSubscriptionQuotaNotExhausted } from '../subscription-quota-admission.js';
import {
  preflightAssistantPricing,
  assistantResultCostCents,
  preflightAssistantSubscription,
  assertAssistantSubscriptionResult,
  assistantSubscriptionSnapshotDigest,
} from '../assistant-pricing-preflight.js';
import { decideCapabilityRoute } from '../routing/capability-router.js';
import { nativeGovernedToolNames } from '../tool-broker/definitions.js';
import {
  providerSnapshotForModelTarget,
  replayProviderSnapshot,
} from '../routing/provider-snapshot.js';
import { executeDurableWorkflow, WorkflowPaused } from '../workflow-engine.js';
import { loadHarnessImages } from '../harness/prompt-images.js';
import { productionAssistantController } from '../harness/dsh/assistant-controller.js';
import { getAssistantFailureDiagnostics } from '../harness/dsh/assistant-diagnostics.js';
import {
  AssistantExecutionUnresolvedError,
  getAssistantFailureUsage,
  assertAssistantTaskComplete,
} from '../harness/dsh/assistant-outcome.js';
import { assertAssistantProviderOutputBound } from '../harness/dsh/assistant-provider.js';
import { DshStartupRejection } from '../harness/dsh/startup-rejection.js';
import type {
  HarnessExecutionInput,
  HarnessExecutionResult,
} from '../harness/adapter.js';
import { NativeQuestionParked } from '../harness/dsh/native-question-wait.js';
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
          .map(
            (skill) =>
              `${skill.id}:${skill.checksum}${skill.bundle ? `:${skill.bundle.checksum}` : ''}`,
          )
          .sort(),
        capabilities: [...resolved.grantedCapabilities].sort(),
        ...(resolved.executionSnapshot?.schemaVersion === 2 &&
        resolved.executionSnapshot.localMcp
          ? { localMcp: resolved.executionSnapshot.localMcp }
          : {}),
        ...(resolved.executionSnapshot?.schemaVersion === 2 &&
        resolved.executionSnapshot.mcpTools?.length
          ? { mcpTools: resolved.executionSnapshot.mcpTools }
          : {}),
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
  const workAutomation = await getDatabase().begin((transaction) =>
    readWorkAutomation(transaction, {
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      userId: execution.job.ownerId,
    }),
  );
  const assistantConfiguration = workAutomation.settings.assistants
    ? input.assistantConfiguration
    : undefined;
  const kernelInput = {
    employeeAssignmentId: input.employeeAssignmentId,
    employeeVersionId: input.employeeVersionId,
    sessionId: input.sessionId,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    resolved,
    workAutomation: workAutomation.settings,
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
  let nativeQuestionParked = false;
  let errorCode: string | undefined;
  let routeDecision: RouteDecision | null = null;
  let routeUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let routeCostCents: number | null = 0;
  let routeUsageComplete = true;
  let routeCacheUsageKnown = true;
  let routeExecutionStarted = false;
  let subscriptionSnapshotCreated = false;
  const loopGuard = new AgentLoopGuard(
    undefined,
    resolved.executionSnapshot?.schemaVersion === 2 &&
      resolved.executionSnapshot.taskRuntimePolicy
      ? 'durable'
      : 'wall',
  );
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
      executionSnapshot.schemaVersion === 2 ? executionSnapshot.mcpTools : [],
      executionSnapshot.schemaVersion === 2
        ? executionSnapshot.localMcp
        : undefined,
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
        return requiredCapability &&
          riceToolRisk(tool.name) !== 'read_only' &&
          !nativeGovernedToolNames.has(tool.name)
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
    // Quota admission is performed below under the tenant lock for the actually
    // selected connection, including fallback. A primary's cash limit cannot
    // preempt selection of a subscription route; Token/run checks remain there.
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
    // run+attempt may already have a different immutable decision than today's
    // router selection. Recover both credentials and admission identity from
    // that exact frozen target, including same-model/different-connection cases.
    const frozenRouteTargets = frozenModelSnapshot
      ? [
          frozenModelSnapshot,
          ...(frozenModelSnapshot.fallbackPolicy === 'explicit'
            ? frozenModelSnapshot.resolvedFallbacks
            : []),
        ].filter(
          (target) =>
            target.connectionId === routeDecision!.modelConnectionId &&
            target.modelCatalogEntryId === routeDecision!.modelCatalogEntryId &&
            target.harness === routeDecision!.harness &&
            target.provider === routeDecision!.provider &&
            target.model === routeDecision!.model,
        )
      : [];
    const providerSnapshot =
      frozenRouteTargets.length === 1
        ? providerSnapshotForModelTarget(frozenRouteTargets[0]!)
        : replayProviderSnapshot({
            decision: routeDecision,
            original: resolved.providerSnapshot,
            fallbacks: fallbackSnapshots,
            reasoningEffort: executionSnapshot.runtimePolicy.reasoningEffort,
          });
    const subscriptionSnapshot = preflightAssistantSubscription({
      sessionId: input.sessionId,
      modelSnapshot: frozenModelSnapshot,
      decision: routeDecision,
      providerSnapshot,
    });
    const modelBudgetScope = {
      verifiedSubscription: !!subscriptionSnapshot,
      governedAssistants:
        objectInput(assistantConfiguration).allowAssistants === true,
      workflow: routeDecision.selectedKind === 'workflow',
    };
    const taskProgress =
      subscriptionSnapshot &&
      executionSnapshot.schemaVersion === 2 &&
      executionSnapshot.taskRuntimePolicy
        ? createTaskProgressRuntime({
            context: execution.context,
            worker: workflowLease,
          })
        : undefined;
    if (taskProgress) loopGuard.observeCallsOnly();
    if (subscriptionSnapshot)
      assertSubscriptionQuotaNotExhausted(codexStatus.quota);
    assertAssistantProviderOutputBound(
      providerSnapshot,
      objectInput(assistantConfiguration).allowAssistants === true,
      subscriptionSnapshot,
    );
    const assistantPriceSnapshot = preflightAssistantPricing({
      enabled: objectInput(assistantConfiguration).allowAssistants === true,
      sessionId: input.sessionId,
      deadlineAt: execution.job.timeoutAt,
      modelSnapshot: frozenModelSnapshot,
      decision: routeDecision,
      providerSnapshot,
      hasNonTextInput:
        kernel.imageAttachments.length > 0 || harnessImages.length > 0,
    });
    if (frozenModelSnapshot) {
      if (
        frozenRouteTargets.length !== 1 ||
        routeDecision.modelPolicyRevision !== frozenModelSnapshot.policyRevision
      )
        throw new HandlerError(
          'ROUTE_REPLAY_INVALID',
          'Stored route does not identify an authorized frozen model target',
          false,
        );
      try {
        const actualGovernance = governance?.providers.find(
          (provider) =>
            provider.connectionId === routeDecision!.modelConnectionId,
        );
        if (actualGovernance) assertProviderAvailable(actualGovernance);
        // This is the sole resource/quota admission. A newly selected Codex
        // fallback must never exempt a persisted API route from unknown cash.
        await admitModelExecution({
          organizationId: execution.context.organizationId,
          workspaceId: execution.context.workspaceId!,
          userId: executionSnapshot.tenantContext.actorId,
          employeeId: executionSnapshot.employee.id,
          connectionId: frozenRouteTargets[0]!.connectionId,
          requestedTokens: modelAdmissionTokenEstimate({
            ...modelBudgetScope,
            limits: frozenModelSnapshot.runLimits,
            estimatedInputTokens: estimateConversationTokens(
              [
                kernel.systemInstructions,
                kernel.bootstrapConversation,
                kernel.authorizedMemoryContext,
                kernel.userRequest,
              ].join('\n'),
            ),
          }),
          requestedRuntimeMs: executionSnapshot.runtimePolicy.timeoutMs,
          ...(executionSnapshot.schemaVersion === 2 &&
          executionSnapshot.taskRuntimePolicy
            ? { runId: execution.context.runId }
            : {}),
        });
      } catch (error) {
        // No dispatch occurred. The existing pre-dispatch failure path records
        // this persisted attempt as failed with zero actual tokens, not unknown
        // usage. The previously stored receipts that caused denial stay intact.
        if (error instanceof ModelGovernanceError)
          throw new HandlerError(
            error.code,
            error.scope
              ? `The ${error.scope} model resource limit has been reached`
              : error.code === 'MODEL_TOKEN_USAGE_UNKNOWN'
                ? 'Historical model Token usage is unresolved; administrator reconciliation or explicit budget review is required'
                : error.code === 'MODEL_COST_USAGE_UNKNOWN'
                  ? 'Historical model API cost is unresolved; administrator reconciliation is required'
                  : 'The organization model quota has been reached',
            false,
          );
        throw error;
      }
    }
    if (subscriptionSnapshot) {
      const frozen = await freezeRouteSubscriptionSnapshot({
        organizationId: execution.context.organizationId,
        workspaceId: execution.context.workspaceId!,
        decisionId: routeDecision.id,
        snapshot: subscriptionSnapshot,
      });
      subscriptionSnapshotCreated = frozen.frozen;
      routeCostCents = null;
    }
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
      executionSnapshot.schemaVersion === 2 ? executionSnapshot.mcpTools : [],
      executionSnapshot.schemaVersion === 2
        ? executionSnapshot.localMcp
        : undefined,
    ).filter(
      (tool) =>
        !tool.name.startsWith('assistant.') ||
        objectInput(assistantConfiguration).allowAssistants === true,
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
        `AllRice authorized route for this turn: ${routeDecision.selectedKind} (${routeDecision.selectedCandidateId}). Tenant-authorized read-only tools are supplied as a stable capability set. Granted execution adapters, including local.process.execute, cloud.process.execute and cloud.mcp.call, are selected by the native DSH Agent Loop. The platform applies the member work settings above to each operation. Other side-effect tools require an explicit route selection. Tool visibility and user-question answers are never action approvals. Use only the capabilities and tools supplied for this turn.`,
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
    const assistants = productionAssistantController({
      nativeSkills: resolved.nativeSkills,
      configuration: assistantConfiguration,
      context: execution.context,
      worker: workflowLease,
      runLimits,
      priceSnapshot: assistantPriceSnapshot,
      subscriptionSnapshot,
      serverPricingProviderSnapshot:
        (assistantPriceSnapshot || subscriptionSnapshot) &&
        providerSnapshot.provider === 'dsh'
          ? providerSnapshot
          : undefined,
      tools,
      authorize: assertAssistantAuthority,
      storage: new LocalStorageAdapter(
        process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
      ),
      signal,
    });
    if (assistants && (adapter.kind !== 'dsh' || selectedWorkflow)) {
      throw new HandlerError(
        'ASSISTANT_ROUTE_UNAVAILABLE',
        'Governed assistants require an ordinary native DSH task',
        false,
      );
    }
    if (runLimits) {
      const estimatedInputTokens = estimateConversationTokens(
        [
          routedKernel.systemInstructions,
          routedKernel.bootstrapConversation,
          routedKernel.authorizedMemoryContext,
          routedKernel.userRequest,
        ].join('\n'),
      );
      assertInitialModelInputBudget({
        ...modelBudgetScope,
        limits: runLimits,
        estimatedInputTokens,
      });
    }
    let steerPolling = true;
    let steerLoop: Promise<void> | undefined;
    let questionWait: HarnessExecutionInput['questionWait'];
    if (
      taskProgress &&
      !assistants &&
      !selectedWorkflow &&
      adapter.kind === 'dsh'
    ) {
      const waitOwner = { context: execution.context, worker: workflowLease };
      const checkpoint = await readNativeQuestionWait({
        ...waitOwner,
        configChecksum,
        generation: runtime.generation,
      });
      const command = checkpoint
        ? await claimConversationSteer({
            ...ownership,
            generation: runtime.generation,
            turnId: checkpoint.turnId,
          })
        : null;
      if (checkpoint && (!command || command.inputKind !== 'ask_user'))
        throw new HandlerError(
          'NATIVE_WAIT_ANSWER_UNAVAILABLE',
          '等待中的问题尚无可恢复的回答。',
          false,
        );
      questionWait = {
        ...(checkpoint && command
          ? {
              resume: {
                sessionId: checkpoint.sessionId,
                questionId: checkpoint.questionId,
                turnId: checkpoint.turnId,
                inputId: command.clientUserMessageId,
                text: command.message,
              },
            }
          : {}),
        adopted: async (proof) => {
          if (!checkpoint || !command || proof.status !== 'adopted')
            throw new HandlerError(
              'NATIVE_WAIT_ANSWER_UNPROVEN',
              '回答尚未得到持久化接收确认。',
              false,
            );
          await consumeConversationSteer({
            commandId: command.id,
            workerId: workflowLease.workerId,
            proof,
          });
          await continueNativeQuestion({
            ...waitOwner,
            questionId: checkpoint.questionId,
          });
        },
        park: async (next, receipt) => {
          // This native segment was deliberately interrupted at a question;
          // its usage is settled once, while the original Run stays waiting.
          await completeRouteDecision({
            organizationId: ownership.organizationId,
            workspaceId: ownership.workspaceId,
            outcome: {
              decisionId: routeDecision!.id,
              status: 'canceled',
              ...receipt.usage,
              costCents: null,
              usageComplete: receipt.usageComplete,
              cacheUsageKnown: receipt.cacheUsageKnown,
              errorCode: 'NATIVE_QUESTION_PARKED',
              failureCategory: null,
              completedAt: new Date().toISOString(),
            },
          });
          await parkNativeQuestion({
            ...waitOwner,
            checkpoint: next,
            configChecksum,
            generation: runtime.generation,
          });
          nativeQuestionParked = true;
        },
      };
    }
    const workflowCitations: typeof knowledge.citations = [];
    // Once a normal assistant or subscription execution starts, any transport, tool,
    // revocation or lease failure is incomplete accounting until an authoritative
    // tree outcome replaces it. Zero here is only a confirmed subtotal, not free
    // completed execution. Legacy API single-agent routes are unchanged.
    if (
      subscriptionSnapshot ||
      (assistants && routeDecision.selectedKind !== 'workflow')
    ) {
      routeCostCents = null;
      routeUsageComplete = false;
      routeCacheUsageKnown = false;
    }
    routeExecutionStarted = true;
    if (
      questionWait &&
      !(await beginNativeTask({
        context: execution.context,
        worker: workflowLease,
        attempt: execution.job.attempt,
      }))
    )
      throw new HandlerError(
        'DSH_EXECUTION_OUTCOME_UNKNOWN',
        '先前执行进程已中断；结果不明的操作不会自动重跑，请查看已保留的内容与执行记录。',
        false,
      );
    const result: HarnessExecutionResult =
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
                    nativeSkills: resolved.nativeSkills,
                    localMcp:
                      executionSnapshot.schemaVersion === 2
                        ? executionSnapshot.localMcp
                        : undefined,
                    frozenMcpTools:
                      executionSnapshot.schemaVersion === 2
                        ? executionSnapshot.mcpTools
                        : [],
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
                  progress: taskProgress,
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
              progress: taskProgress,
              questionWait,
              assistants,
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
                        nativeSkills: resolved.nativeSkills,
                        localMcp:
                          executionSnapshot.schemaVersion === 2
                            ? executionSnapshot.localMcp
                            : undefined,
                        frozenMcpTools:
                          executionSnapshot.schemaVersion === 2
                            ? executionSnapshot.mcpTools
                            : [],
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
    if (questionWait)
      await completeNativeTask({
        context: execution.context,
        worker: workflowLease,
        attempt: execution.job.attempt,
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
    // Keep subscription accounting incomplete until identity-bound receipts
    // are verified. A forged/mismatched result cannot claim successful delivery.
    routeUsageComplete = subscriptionSnapshot
      ? false
      : (result.usageComplete ?? true);
    routeCacheUsageKnown = subscriptionSnapshot
      ? false
      : (result.cacheUsageKnown ?? true);
    if (subscriptionSnapshot) {
      if (assistants)
        assertAssistantSubscriptionResult(subscriptionSnapshot, result);
      else {
        if (
          result.provider !== subscriptionSnapshot.provider ||
          result.model !== subscriptionSnapshot.model ||
          result.costCurrency !== undefined ||
          result.priceSnapshotDigest !== undefined ||
          (result.estimatedCostCents !== undefined &&
            result.estimatedCostCents !== null)
        )
          throw new HandlerError(
            'ASSISTANT_SUBSCRIPTION_RESULT_UNVERIFIED',
            '订阅返回模型与冻结身份不一致。',
            false,
          );
        // Ordinary provider adapters do not price subscriptions. Project trusted
        // identity explicitly; never run the legacy missing-price=zero estimator.
        Object.assign(result, {
          billingMode: 'subscription',
          costBasis: 'not_applicable',
          estimatedCostCents: null,
          costEstimateAvailable: false,
          actualCostKnown: false,
          usageComplete: result.usageComplete ?? false,
          cacheUsageKnown: result.cacheUsageKnown ?? false,
          subscriptionSnapshotDigest:
            assistantSubscriptionSnapshotDigest(subscriptionSnapshot),
        });
      }
      routeUsageComplete = result.usageComplete ?? false;
      routeCacheUsageKnown = result.cacheUsageKnown ?? false;
    }
    routeCostCents = subscriptionSnapshot
      ? null
      : assistants && assistantPriceSnapshot
        ? assistantResultCostCents(assistantPriceSnapshot, result)
        : result.costEstimateAvailable === false
          ? null
          : estimateModelCostCents({
              provider: result.provider,
              model: result.model,
              ...result.usage,
            });
    const budgetWarning = checkCompletedModelBudget({
      ...modelBudgetScope,
      limits: runLimits,
      result,
      governedAssistants: !!assistants,
      costCents: routeCostCents,
    });
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
    assertAssistantTaskComplete(result, modelBudgetScope.verifiedSubscription);
    await completeRouteDecision({
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      outcome: {
        decisionId: routeDecision.id,
        status: 'succeeded',
        ...routeUsage,
        costCents: routeCostCents,
        usageComplete: routeUsageComplete,
        cacheUsageKnown: routeCacheUsageKnown,
        errorCode: null,
        failureCategory: null,
        completedAt: new Date().toISOString(),
      },
    });
    outcome = 'idle';
    const priorWaitUsage = questionWait?.resume
      ? await readParkedNativeUsage(execution.context)
      : null;
    return {
      ...result,
      ...(priorWaitUsage
        ? {
            usage: {
              inputTokens:
                result.usage.inputTokens + priorWaitUsage.usage.inputTokens,
              cachedInputTokens:
                result.usage.cachedInputTokens +
                priorWaitUsage.usage.cachedInputTokens,
              outputTokens:
                result.usage.outputTokens + priorWaitUsage.usage.outputTokens,
            },
            usageComplete:
              result.usageComplete === true && priorWaitUsage.usageComplete,
            cacheUsageKnown:
              result.cacheUsageKnown === true && priorWaitUsage.cacheUsageKnown,
          }
        : {}),
      ...(budgetWarning ? { budgetWarning } : {}),
      citations: [...knowledge.citations, ...workflowCitations].filter(
        (citation, index, values) =>
          values.findIndex(
            (candidate) =>
              candidate.type === citation.type && candidate.id === citation.id,
          ) === index,
      ),
    };
  } catch (caught) {
    if (caught instanceof NativeQuestionParked && caught.persisted)
      throw caught;
    const error =
      caught instanceof NativeWaitAuthorityError
        ? new HandlerError(
            caught.code.toUpperCase(),
            '等待期间的授权或配置已变更，未恢复执行。请重新确认后发起任务。',
            false,
          )
        : caught;
    const failedUsage = getAssistantFailureUsage(
      error,
      execution.context.runId,
      execution.job.attempt,
    );
    if (failedUsage) {
      routeUsage = failedUsage.usage;
      routeCostCents = null;
      routeUsageComplete = failedUsage.usageComplete;
      routeCacheUsageKnown = failedUsage.cacheUsageKnown;
    } else if (error instanceof AssistantExecutionUnresolvedError) {
      routeUsage = error.usage;
      routeCostCents = null;
      routeUsageComplete = error.usageComplete;
      routeCacheUsageKnown = false;
    }
    if (error instanceof WorkflowPaused) {
      outcome = 'idle';
      throw error;
    }
    outcome = signal.aborted ? 'interrupted' : 'error';
    if (runtime.activeTurnId) {
      const assistantDiagnostics = getAssistantFailureDiagnostics(error);
      await appendChatFlowEvent(
        signal.aborted ? 'turn.canceled' : 'turn.failed',
        {
          source: routeDecision?.harness ?? kernel.harness,
          threadId: runtime.threadId,
          turnId: runtime.activeTurnId,
          generation: runtime.generation,
          ...(assistantDiagnostics?.failures.length
            ? { assistantDiagnostics }
            : {}),
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
        ...(!routeExecutionStarted ||
        (decision.selectedKind !== 'workflow' &&
          error instanceof DshStartupRejection &&
          error.belongsTo(execution.context.runId, execution.job.attempt))
          ? { undispatched: { subscriptionSnapshotCreated } }
          : {}),
        outcome: {
          decisionId: decision.id,
          status: signal.aborted ? 'canceled' : 'failed',
          ...routeUsage,
          costCents: routeCostCents,
          usageComplete: routeUsageComplete,
          cacheUsageKnown: routeCacheUsageKnown,
          errorCode,
          failureCategory: errorCode.startsWith('ASSISTANT_')
            ? null
            : classifyProviderFailure(errorCode),
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
      if (!nativeQuestionParked)
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
