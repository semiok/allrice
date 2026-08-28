import { createHash, randomUUID } from 'node:crypto';

import {
  EmployeeKernelRequestSchema,
  RouteDecisionSchema,
  type HarnessEvent,
  type HarnessExecutionSnapshot,
  type ResolvedModelTarget,
  type RouteDecision,
} from '@allrice/contracts';

import {
  ConversationRuntimeError,
  QueueError,
  acquireConversationRuntime,
  admitModelExecution,
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
  getModelGovernanceSnapshot,
  getWorkflowExecution,
  listContextCheckpointEvidence,
  listFailedRouteDecisions,
  recordConversationTurn,
  recordConversationNativeContext,
  recordConversationUsage,
  recordRouteDecision,
  recordToolBrokerAudit,
  ensureWorkflowRunForExecution,
  rejectConversationSteer,
  releaseConversationRuntime,
  resolveEmployeeExecution,
  assertQuotaAvailable,
  saveContextCheckpoint,
  shouldCreateContextCheckpoint,
  ModelGovernanceError,
  startClaimedJob,
  type ClaimedExecution,
} from '@allrice/database';

import { AgentLoopGuard, AgentLoopGuardError } from './agent-loop-guard.js';
import { prepareExecutionIsolation } from './isolation.js';
import { assembleEmployeeKernel } from './employee-kernel.js';
import { HandlerError } from './errors.js';
import { HarnessEventBatcher } from './harness/delta-batcher.js';
import { normalizeHarnessRunEvent } from './harness/runtime-contract.js';
import {
  classifyProviderFailure,
  failedDecisionRouteKey,
  getHarnessRouter,
  harnessRouteKey,
} from './harness/router.js';
import { buildAuthorizedKnowledgeContext } from './knowledge.js';
import { estimateModelCostCents } from './model-cost.js';
import { decideCapabilityRoute } from './routing/capability-router.js';
import { executeDurableWorkflow, WorkflowPaused } from './workflow-engine.js';
import {
  executeRiceTool,
  riceToolCapability,
  riceToolDefinitionsForCapabilities,
  riceToolDefinitionsForTurn,
  riceToolRisk,
} from './tool-broker.js';

function providerName(snapshot: HarnessExecutionSnapshot) {
  return snapshot.provider === 'codex' ? 'openai-codex' : snapshot.route;
}

function providerSnapshotForModelTarget(
  target: ResolvedModelTarget,
): HarnessExecutionSnapshot {
  return target.provider === 'openai-codex' || target.harness === 'codex'
    ? {
        provider: 'dsh',
        authMode: 'platform_subscription',
        route: 'openai-codex',
        model: target.model,
        reasoningEffort:
          target.reasoningEffort === 'none' ? 'low' : target.reasoningEffort,
        credentialReference:
          target.credentialReference ?? 'deployment:codex-default',
        baseUrl: null,
      }
    : {
        provider: 'dsh',
        authMode: 'allrice_credential',
        route:
          target.provider === 'deepseek-official'
            ? 'deepseek-official'
            : 'openai-compatible',
        model: target.model,
        reasoningEffort: target.reasoningEffort,
        credentialReference: target.credentialReference!,
        baseUrl: target.baseUrl,
      };
}

function replayProviderSnapshot(input: {
  decision: RouteDecision;
  original: HarnessExecutionSnapshot;
  fallbacks?: readonly HarnessExecutionSnapshot[];
  reasoningEffort: 'none' | 'low' | 'medium' | 'high' | 'xhigh';
}): HarnessExecutionSnapshot {
  const frozen = [input.original, ...(input.fallbacks ?? [])].find(
    (snapshot) =>
      (snapshot.provider === 'codex' ? 'codex' : 'dsh') ===
        input.decision.harness && snapshot.model === input.decision.model,
  );
  if (frozen) return frozen;
  if (
    input.decision.harness === 'codex' ||
    input.decision.provider === 'openai-codex' ||
    input.decision.provider === 'codex'
  ) {
    return {
      provider: 'dsh',
      authMode: 'platform_subscription',
      route: 'openai-codex',
      model: input.decision.model,
      reasoningEffort:
        input.reasoningEffort === 'none' ? 'low' : input.reasoningEffort,
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
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
  workflowLease: {
    workerId: string;
    jobId: string;
    leaseToken: string;
    leaseMs: number;
  },
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
            (provider) =>
              provider.killSwitch || provider.circuitState === 'open',
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
              selectedFallback?.connectionId ??
              frozenModelSnapshot.connectionId,
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
                storageRoot:
                  process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
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
                      capabilities: resolved.grantedCapabilities,
                      storageRoot:
                        process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
                      sessionId: kernel.sessionId,
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
                    capabilitySnapshot.agentSkills
                      .filter((binding) => binding.effective)
                      .map((binding) => binding.revision.id),
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
                    storageObjects: resolved.skillArtifacts
                      .filter((artifact) =>
                        skillIds.includes(artifact.skillVersionId),
                      )
                      .map((artifact) => artifact.storageObject),
                    workDirectory: isolation.workDirectory,
                    executionEnvironment: isolation.environment,
                    providerSnapshot,
                    signal,
                    attempt: execution.job.attempt,
                    generation: runtime.generation,
                    maxOutputTokens: runLimits?.maxOutputTokens,
                    onEvent: guardedHarnessEvent,
                    tools: [],
                    threadId: runtime.threadId,
                    onThreadBound: async ({
                      threadId,
                      resumed,
                      replacedThreadId,
                    }) => {
                      runtime = await bindConversationThread({
                        ...ownership,
                        threadId,
                      });
                      await appendChatFlowEvent('session.bound', {
                        source: adapter.kind,
                        threadId,
                        generation: runtime.generation,
                        resumed,
                        replacedThreadId,
                      });
                      return { generation: runtime.generation };
                    },
                    onTurnStarted: async ({ threadId, turnId }) => {
                      runtime = await recordConversationTurn({
                        ...ownership,
                        threadId,
                        turnId,
                      });
                      await appendChatFlowEvent('turn.started', {
                        source: adapter.kind,
                        threadId,
                        turnId,
                        generation: runtime.generation,
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
                    (event.name === 'web.search' || event.name === 'web.fetch')
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
                tools,
                onToolCall:
                  tools.length > 0
                    ? (call) =>
                        executeRiceTool({
                          context: execution.context,
                          capabilities: resolved.grantedCapabilities,
                          storageRoot:
                            process.env.ALLRICE_STORAGE_ROOT ??
                            '.local/storage',
                          skillVersionIds: resolved.nativeSkills.map(
                            (skill) => skill.id,
                          ),
                          sessionId:
                            typeof input.sessionId === 'string'
                              ? input.sessionId
                              : undefined,
                          call,
                        })
                    : undefined,
                threadId: runtime.threadId,
                onThreadBound: async ({
                  threadId,
                  resumed,
                  replacedThreadId,
                }) => {
                  runtime = await bindConversationThread({
                    ...ownership,
                    threadId,
                  });
                  await appendChatFlowEvent('session.bound', {
                    source: adapter.kind,
                    threadId,
                    generation: runtime.generation,
                    resumed,
                    replacedThreadId,
                  });
                  return { generation: runtime.generation };
                },
                onTurnStarted: async ({ threadId, turnId }) => {
                  runtime = await recordConversationTurn({
                    ...ownership,
                    threadId,
                    turnId,
                  });
                  await appendChatFlowEvent('turn.started', {
                    source: adapter.kind,
                    threadId,
                    turnId,
                    generation: runtime.generation,
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
                        await new Promise((resolve) =>
                          setTimeout(resolve, 150),
                        );
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
                            error instanceof Error
                              ? error.message
                              : 'unknown error',
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
                    message:
                      error instanceof Error ? error.message : 'unknown error',
                  });
                });
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
      if ('nativeContextPressure' in result && result.nativeContextPressure) {
        runtime = await recordConversationNativeContext({
          ...ownership,
          generation: runtime.generation,
          ...result.nativeContextPressure,
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
        shouldCreateContextCheckpoint({
          estimatedTokens,
          thresholdTokens: runtime.compactThresholdTokens,
          coveredThroughMessageId,
          latestCoveredThroughMessageId:
            checkpoint?.coveredThroughMessageId ?? null,
        })
      ) {
        try {
          if (adapter.contextStrategy === 'chatflow-managed') {
            if (!adapter.compact) {
              throw new Error(
                'Harness advertises managed compaction without an implementation',
              );
            }
            await appendJobEvent({
              ...workflowLease,
              type: 'context.compaction.started',
              payload: { source: adapter.kind, threadId: runtime.threadId },
            });
            await adapter.compact({ threadId: runtime.threadId });
            await appendJobEvent({
              ...workflowLease,
              type: 'context.compaction.completed',
              payload: { source: adapter.kind, threadId: runtime.threadId },
            });
          }
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
          await appendJobEvent({
            ...workflowLease,
            type: 'context.checkpoint.created',
            payload: {
              source: adapter.kind,
              threadId: runtime.threadId,
              estimatedTokens,
              contextStrategy: adapter.contextStrategy,
            },
          });
        } catch (error) {
          await appendJobEvent({
            ...workflowLease,
            type: 'context.compaction.failed',
            payload: {
              source: adapter.kind,
              threadId: runtime.threadId,
              message: error instanceof Error ? error.message : 'unknown error',
            },
          }).catch(() => undefined);
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
                candidate.type === citation.type &&
                candidate.id === citation.id,
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
  if (execution.payload.type === 'allrice.workflow.run') {
    const workflow = await getWorkflowExecution({
      organizationId: execution.context.organizationId,
      workspaceId: execution.context.workspaceId!,
      runId: execution.context.runId,
    });
    return executeDurableWorkflow({
      execution,
      ...workflowLease,
      storageRoot: process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
      executeStep: async ({ step, value }) => {
        if (step.kind !== 'knowledge') {
          throw new HandlerError(
            'WORKFLOW_CHAT_CONTEXT_REQUIRED',
            'Model, Skill and Tool workflow steps must start from an employee conversation',
            false,
          );
        }
        const configured = step.input.knowledgeRevisionIds;
        const knowledgeRevisionIds = Array.isArray(configured)
          ? configured.filter(
              (item): item is string => typeof item === 'string',
            )
          : [];
        const retrieved = await buildAuthorizedKnowledgeContext({
          context: execution.context,
          employeeId: workflow.employeeId,
          knowledgeRevisionIds,
          query:
            typeof step.input.query === 'string'
              ? step.input.query
              : JSON.stringify(value.workflowInput),
          storageRoot: process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
        });
        return {
          output: {
            context: retrieved.context,
            citations: retrieved.citations,
          },
        };
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
  const normalized = normalizeHarnessRunEvent(input.event);
  await appendJobEvent({
    workerId: input.workerId,
    jobId: input.jobId,
    leaseToken: input.leaseToken,
    type: normalized.type,
    payload: normalized.payload,
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
      {
        workerId: input.workerId,
        jobId: input.jobId,
        leaseToken: input.leaseToken,
        leaseMs: input.leaseMs,
      },
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
