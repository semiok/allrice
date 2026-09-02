import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  DshExecutionSnapshotSchema,
  EmployeeKernelRequestSchema,
  ExecutionContextSchema,
  type HarnessEvent,
  type SkillCapability,
} from '@allrice/contracts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
} from '@allrice/database';

import { HandlerError } from './errors.js';
import { DshHarnessAdapter } from './harness/dsh-adapter.js';
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
 * Runs a platform draft as an ephemeral preview in a selected tenant context.
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

  const adapter = new DshHarnessAdapter({
    runtimeRoot: resolve(input.executionRoot, 'platform-employee-tests'),
    requestTimeoutMs: test.runtimeProfile.timeoutMs,
  });
  const ids = {
    assignmentId: randomUUID(),
    versionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
  };
  const events: HarnessEvent[] = [];
  try {
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
    for (const toolName of test.runtimeProfile.toolNames) {
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
    const tools = riceReadOnlyToolDefinitionsForPreview(
      grantedCapabilities,
      test.runtimeProfile.toolNames,
    );
    const snapshot = DshExecutionSnapshotSchema.parse({
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
    const result = await adapter.execute({
      kernel: EmployeeKernelRequestSchema.parse({
        schemaVersion: 1,
        harness: 'dsh',
        employeeAssignmentId: ids.assignmentId,
        employeeVersionId: ids.versionId,
        sessionId: ids.sessionId,
        userMessageId: ids.userMessageId,
        assistantMessageId: ids.assistantMessageId,
        systemInstructions: test.runtimeProfile.systemPrompt,
        userRequest: test.input.prompt,
        bootstrapConversation: '',
        authorizedMemoryContext: '',
        grantedCapabilities,
        skillVersionIds: test.runtimeProfile.nativeSkillIds,
      }),
      providerSnapshot: snapshot,
      storageObjects: [],
      nativeSkills: test.nativeSkills,
      workDirectory: resolve(input.executionRoot, 'platform-employee-tests'),
      executionEnvironment: {
        ALLRICE_ORGANIZATION_ID: test.previewContext.organizationId,
        ALLRICE_WORKSPACE_ID: test.previewContext.workspaceId,
        ALLRICE_OWNER_ID: test.previewContext.ownerId,
        ALLRICE_PLATFORM_EMPLOYEE_PREVIEW: 'true',
      },
      signal: input.signal,
      attempt: 1,
      generation: 0,
      maxOutputTokens: 8_000,
      tools,
      onToolCall:
        tools.length > 0
          ? (call) =>
              executeRiceTool({
                context: executionContext,
                managedBrowserJobAttempt: test.previewExecution.jobAttempt,
                managedBrowserJobLeaseToken: test.previewExecution.leaseToken,
                capabilities: grantedCapabilities,
                storageRoot:
                  process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
                skillVersionIds: test.nativeSkills.map((skill) => skill.id),
                platformTestRunId: test.id,
                platformActorLabel: test.requestedByLabel,
                signal: input.signal,
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
    await completePlatformEmployeeTestRun(test.id, {
      answer: result.answer,
      provider: result.provider,
      model: result.model,
      threadId: result.threadId ?? null,
      usage: result.usage,
      events,
      error: null,
    });
  } catch (error) {
    await completePlatformEmployeeTestRun(test.id, {
      answer: null,
      provider: test.runtimeProfile.provider,
      model: test.runtimeProfile.model,
      threadId: null,
      usage: null,
      events,
      error: {
        code: errorCode(error),
        message:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : 'Snow 预览运行失败。',
      },
    });
  } finally {
    await adapter.close();
  }
  return true;
}
