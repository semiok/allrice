import {
  employeeMethodFileTools,
  executeEmployeeMethodFileStep,
} from './employee-method-file-tests.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  DshExecutionSnapshotSchema,
  EmployeeKernelRequestSchema,
  ExecutionContextSchema,
  type HarnessEvent,
  type SkillCapability,
  type PlatformEmployeeTestRunOutput,
} from '@allrice/contracts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
  employeeMethodTestStillCurrent,
  methodFileExecutionUnverified,
  freezeRouteSubscriptionSnapshot,
} from '@allrice/database';

import { HandlerError } from './errors.js';
import { DshHarnessAdapter } from './harness/dsh-adapter.js';
import { providerSnapshotForModelTarget } from './routing/provider-snapshot.js';
import { preflightAssistantSubscription } from './assistant-pricing-preflight.js';
import { estimateModelCostCents } from './model-cost.js';
import { checkCompletedModelBudget } from './model-result-budget.js';
import { getAssistantFailureUsage } from './harness/dsh/assistant-outcome.js';
import {
  executeRiceTool,
  riceReadOnlyToolDefinitionsForPreview,
  riceToolCapability,
} from './tool-broker.js';

function errorCode(error: unknown) {
  return error instanceof HandlerError
    ? error.code
    : error instanceof Error
      ? error.name || 'PLATFORM_EMPLOYEE_TEST_FAILED'
      : 'PLATFORM_EMPLOYEE_TEST_FAILED';
}

/**
 * Runs a platform draft in the internal test workspace unless a company was explicitly selected.
 * The draft Runtime Profile is never published, while read-only Tool Broker
 * calls use the selected workspace's real policy, files and online Bridge.
 */
export async function executeNextPlatformEmployeeTest(input: {
  workerId: string;
  executionRoot: string;
  signal: AbortSignal;
}) {
  const test = await claimNextPlatformEmployeeTestRun(input.workerId);
  if (!test) return false;

  const testDirectory = resolve(
    input.executionRoot,
    'platform-employee-tests',
    test.id,
  );
  const adapter = new DshHarnessAdapter({
    runtimeRoot: testDirectory,
    requestTimeoutMs:
      test.methodCandidate?.timeoutMs ?? test.runtimeProfile.timeoutMs,
  });
  const method = test.methodCandidate;
  let methodExecutionIssue: string | undefined;
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  let guard: ReturnType<typeof setInterval> | undefined;
  let checking: Promise<void> | undefined;
  const meter: NonNullable<PlatformEmployeeTestRunOutput['modelExecution']> = {
    dispatched: false,
    subscriptionSnapshotCreated: false,
    usageComplete: false,
    cacheUsageKnown: false,
    costCents: null,
  };
  let usage: PlatformEmployeeTestRunOutput['usage'] = null;
  const checkCandidate = (): Promise<void> => {
    // Finalization joins an in-flight poll instead of skipping its verdict.
    if (checking) return checking;
    if (!method || signal.aborted) return Promise.resolve();
    checking = (async () => {
      try {
        if (!(await employeeMethodTestStillCurrent(test.id)))
          throw new HandlerError(
            'EMPLOYEE_METHOD_TEST_STALE',
            '候选、权限或模型连接已变化，测试已停止；请重新检查后发起测试。',
            false,
          );
      } catch (error) {
        // An unavailable authority read also fails closed.
        controller.abort(error);
      }
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  };
  const ids = {
    assignmentId: randomUUID(),
    versionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
  };
  const events: HarnessEvent[] = [];
  try {
    await checkCandidate();
    signal.throwIfAborted();
    if (method)
      guard = setInterval(() => {
        void checkCandidate();
      }, 2_000);
    const executionContext = ExecutionContextSchema.parse({
      executionId: randomUUID(),
      runId: test.previewExecution.runId,
      jobId: test.previewExecution.jobId,
      worker: { type: 'worker', id: input.workerId },
      delegatedBy: { type: 'user', id: test.previewContext.ownerId },
      organizationId: test.previewContext.organizationId,
      workspaceId: test.previewContext.workspaceId,
      policySnapshot: test.previewExecution.policySnapshot,
      startedAt: test.previewExecution.startedAt,
    });
    const grantedCapabilities: SkillCapability[] = ['model:invoke'];
    for (const toolName of method ? [] : test.runtimeProfile.toolNames) {
      const capability = riceToolCapability(toolName);
      if (
        capability &&
        !test.runtimeProfile.securityPolicy.deniedCapabilities.includes(
          capability,
        ) &&
        !grantedCapabilities.includes(capability)
      ) {
        grantedCapabilities.push(capability);
      }
    }
    const tools = method
      ? method.caseId === 'cny-file-flow-v1'
        ? employeeMethodFileTools
        : []
      : riceReadOnlyToolDefinitionsForPreview(
          grantedCapabilities,
          test.runtimeProfile.toolNames,
        );
    const snapshot = method
      ? providerSnapshotForModelTarget(method.modelSnapshot)
      : DshExecutionSnapshotSchema.parse({
          provider: 'dsh',
          authMode:
            test.runtimeProfile.provider === 'openai-codex'
              ? 'platform_subscription'
              : 'allrice_credential',
          route: test.runtimeProfile.provider,
          model: test.runtimeProfile.model,
          reasoningEffort: test.runtimeProfile.reasoningEffort,
          credentialReference: test.runtimeProfile.credentialReference,
          baseUrl: test.runtimeProfile.baseUrl,
        });
    const subscriptionSnapshot = method
      ? preflightAssistantSubscription({
          sessionId: method.sourceSessionId,
          modelSnapshot: method.modelSnapshot,
          decision: method.decision,
          providerSnapshot: snapshot,
        })
      : undefined;
    if (subscriptionSnapshot && method) {
      const frozen = await freezeRouteSubscriptionSnapshot({
        organizationId: test.previewContext.organizationId,
        workspaceId: test.previewContext.workspaceId,
        decisionId: method.decision.id,
        snapshot: subscriptionSnapshot,
      });
      meter.subscriptionSnapshotCreated = frozen.frozen;
    }
    signal.throwIfAborted();
    meter.dispatched = true;
    const result = await adapter.execute({
      kernel: EmployeeKernelRequestSchema.parse({
        schemaVersion: 1,
        harness: 'dsh',
        employeeAssignmentId: ids.assignmentId,
        employeeVersionId: ids.versionId,
        sessionId: ids.sessionId,
        userMessageId: ids.userMessageId,
        assistantMessageId: ids.assistantMessageId,
        systemInstructions: [
          test.runtimeProfile.systemPrompt,
          method?.instructions,
        ]
          .filter(Boolean)
          .join('\n\n'),
        userRequest: test.input.prompt,
        bootstrapConversation: '',
        authorizedMemoryContext: '',
        grantedCapabilities,
        skillVersionIds: method ? [] : test.runtimeProfile.nativeSkillIds,
      }),
      providerSnapshot: snapshot,
      storageObjects: [],
      nativeSkills: method ? [] : test.nativeSkills,
      workDirectory: testDirectory,
      executionEnvironment: {
        ALLRICE_ORGANIZATION_ID: test.previewContext.organizationId,
        ALLRICE_WORKSPACE_ID: test.previewContext.workspaceId,
        ALLRICE_OWNER_ID: test.previewContext.ownerId,
        ALLRICE_RUN_ID: test.previewExecution.runId,
        ALLRICE_JOB_ID: test.previewExecution.jobId,
        ALLRICE_ATTEMPT: String(test.previewExecution.jobAttempt),
        ALLRICE_PLATFORM_EMPLOYEE_PREVIEW: 'true',
      },
      signal,
      attempt: 1,
      generation: 0,
      maxOutputTokens: method
        ? Math.min(method.modelSnapshot.runLimits.maxOutputTokens, 8_000)
        : 8_000,
      tools,
      authorizedToolNames: method
        ? tools.map((tool) => tool.name)
        : test.runtimeProfile.toolNames,
      onToolCall:
        method?.caseId === 'cny-file-flow-v1'
          ? (call) =>
              executeEmployeeMethodFileStep({
                context: executionContext,
                testId: test.id,
                onUnverified: (code) => {
                  methodExecutionIssue ??= code;
                },
                leaseToken: test.previewExecution.leaseToken,
                jobAttempt: test.previewExecution.jobAttempt,
                call,
                signal,
                storageRoot:
                  process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
              })
          : tools.length > 0
            ? (call) =>
                executeRiceTool({
                  nativeSkills: test.nativeSkills,
                  context: executionContext,
                  managedBrowserJobAttempt: test.previewExecution.jobAttempt,
                  managedBrowserJobLeaseToken: test.previewExecution.leaseToken,
                  capabilities: grantedCapabilities,
                  storageRoot:
                    process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
                  skillVersionIds: test.nativeSkills.map((skill) => skill.id),
                  platformTestRunId: test.id,
                  platformActorLabel: test.requestedByLabel,
                  signal,
                  call,
                })
            : undefined,
      onEvent: async (event) => {
        // The final answer is persisted separately. Keep the safe native
        // timeline, lifecycle and usage events without storing delta spam.
        if (event.type !== 'assistant.delta' && events.length < 500) {
          events.push(event);
        }
      },
    });
    usage = result.usage;
    if (method) {
      // Match the ordinary single-root receipt rules. A subscription never
      // becomes a cash estimate; missing token receipts remain unknown.
      if (
        subscriptionSnapshot &&
        (result.provider !== subscriptionSnapshot.provider ||
          result.model !== subscriptionSnapshot.model ||
          result.costCurrency !== undefined ||
          result.priceSnapshotDigest !== undefined ||
          (result.estimatedCostCents !== undefined &&
            result.estimatedCostCents !== null))
      )
        throw new HandlerError(
          'ASSISTANT_SUBSCRIPTION_RESULT_UNVERIFIED',
          '测试结果的模型身份与冻结版本不一致。',
          false,
        );
      meter.usageComplete = result.usageComplete ?? false;
      meter.cacheUsageKnown = result.cacheUsageKnown ?? false;
      meter.costCents =
        subscriptionSnapshot ||
        result.costEstimateAvailable === false ||
        !meter.usageComplete
          ? null
          : estimateModelCostCents({
              provider: result.provider,
              model: result.model,
              ...result.usage,
            });
      checkCompletedModelBudget({
        verifiedSubscription: !!subscriptionSnapshot,
        limits: method.modelSnapshot.runLimits,
        result,
        costCents: meter.costCents,
      });
      if (
        method.caseId === 'cny-file-flow-v1' &&
        (methodExecutionIssue ||
          (await methodFileExecutionUnverified(executionContext, test.id)))
      )
        throw new HandlerError(
          'EMPLOYEE_METHOD_TEST_EXECUTION_UNVERIFIED',
          '隔离文件执行尚未获得完整结果，请保留本测试并按明确重试流程处理。',
          false,
        );
      await checkCandidate();
      signal.throwIfAborted();
    }
    await completePlatformEmployeeTestRun(test.id, {
      answer: result.answer,
      provider: result.provider,
      model: result.model,
      threadId: result.threadId ?? null,
      usage: result.usage,
      events,
      error: null,
      ...(method ? { modelExecution: meter } : {}),
    });
  } catch (error) {
    const failedUsage = method
      ? getAssistantFailureUsage(
          error,
          test.previewExecution.runId,
          test.previewExecution.jobAttempt,
        )
      : undefined;
    if (failedUsage) {
      usage = failedUsage.usage;
      meter.usageComplete = failedUsage.usageComplete;
      meter.cacheUsageKnown = failedUsage.cacheUsageKnown;
      meter.costCents = null;
    }
    await completePlatformEmployeeTestRun(test.id, {
      answer: null,
      provider: method?.modelSnapshot.provider ?? test.runtimeProfile.provider,
      model: method?.modelSnapshot.model ?? test.runtimeProfile.model,
      threadId: null,
      usage,
      events,
      error: {
        code: errorCode(
          controller.signal.aborted ? controller.signal.reason : error,
        ),
        message:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : '草稿测试运行失败。',
      },
      ...(method ? { modelExecution: meter } : {}),
    });
  } finally {
    if (guard) clearInterval(guard);
    await adapter.close();
  }
  return true;
}
