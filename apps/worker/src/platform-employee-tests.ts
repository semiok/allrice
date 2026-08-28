import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import {
  DshExecutionSnapshotSchema,
  EmployeeKernelRequestSchema,
  type HarnessEvent,
} from '@allrice/contracts';
import {
  claimNextPlatformEmployeeTestRun,
  completePlatformEmployeeTestRun,
} from '@allrice/database';

import { HandlerError } from './errors.js';
import { DshHarnessAdapter } from './harness/dsh-adapter.js';

function errorCode(error: unknown) {
  return error instanceof HandlerError
    ? error.code
    : error instanceof Error
      ? error.name || 'PLATFORM_EMPLOYEE_TEST_FAILED'
      : 'PLATFORM_EMPLOYEE_TEST_FAILED';
}

/**
 * Runs a platform draft in a disposable DSH runtime. The UUID-shaped
 * isolation context is intentionally not backed by any tenant rows, and no
 * Tool Broker definitions are supplied, so this path cannot access tenant
 * storage, connectors, Bridge devices or local files.
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
    organizationId: randomUUID(),
    workspaceId: randomUUID(),
    ownerId: randomUUID(),
    assignmentId: randomUUID(),
    versionId: randomUUID(),
    sessionId: randomUUID(),
    userMessageId: randomUUID(),
    assistantMessageId: randomUUID(),
  };
  const events: HarnessEvent[] = [];
  try {
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
        grantedCapabilities: ['model:invoke'],
        skillVersionIds: test.runtimeProfile.nativeSkillIds,
      }),
      providerSnapshot: snapshot,
      storageObjects: [],
      nativeSkills: test.nativeSkills,
      workDirectory: resolve(input.executionRoot, 'platform-employee-tests'),
      executionEnvironment: {
        ALLRICE_ORGANIZATION_ID: ids.organizationId,
        ALLRICE_WORKSPACE_ID: ids.workspaceId,
        ALLRICE_OWNER_ID: ids.ownerId,
        ALLRICE_PLATFORM_EMPLOYEE_TEST: 'true',
      },
      signal: input.signal,
      attempt: 1,
      generation: 0,
      maxOutputTokens: 8_000,
      tools: [],
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
            : '隔离 DSH 测试失败。',
      },
    });
  } finally {
    await adapter.close();
  }
  return true;
}
