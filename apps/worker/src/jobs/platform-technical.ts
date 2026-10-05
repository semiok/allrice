import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { EmployeeKernelRequestSchema } from '@allrice/contracts';
import {
  getPlatformTechnicalExecution,
  appendJobEvent,
  recordPlatformTechnicalUsage,
  platformTechnicalToolName,
  type TechnicalTaskLease,
} from '@allrice/database';
import { HandlerError } from '../errors.js';
import { getAssistantFailureUsage } from '../harness/dsh/assistant-outcome.js';
import { DshHarnessAdapter } from '../harness/dsh-adapter.js';
import { executeRiceTool } from '../tool-broker.js';
import type { ClaimedJobHandlerInput } from '../job-runner.js';

export const platformTechnicalToolDefinition = {
  name: platformTechnicalToolName,
  description:
    '读取当前平台受限诊断及本任务的问题引用。仅支持只读，不支持修改或发布。',
  inputSchema: {
    type: 'object',
    properties: { scope: { type: 'string', enum: ['current'] } },
    required: ['scope'],
    additionalProperties: false,
  },
};
/** Runs on the existing leased queue, DSH adapter and trusted progress boundary. */
export async function executePlatformTechnicalTask(
  input: ClaimedJobHandlerInput,
) {
  const lease: TechnicalTaskLease = {
    ...input.workflowLease,
    attempt: input.execution.job.attempt,
  };
  const task = await getPlatformTechnicalExecution(lease);
  const remainingMs = new Date(task.deadlineAt).getTime() - Date.now();
  if (remainingMs <= 0)
    throw new HandlerError('JOB_TIMEOUT', '技术诊断任务已超时', false);
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(remainingMs),
  ]);
  const adapter = new DshHarnessAdapter({
    runtimeRoot: input.isolation.workDirectory,
    requestTimeoutMs: Math.max(1000, remainingMs),
    cordisConfig: resolve(
      import.meta.dirname,
      '../../dsh/allrice-technical.cordis.yml',
    ),
  });
  const sessionId = randomUUID();
  const modelCalls = new Set<string>();
  const progressReceipts = new Set<string>();
  try {
    const result = await adapter.execute({
      kernel: EmployeeKernelRequestSchema.parse({
        schemaVersion: 1,
        harness: 'dsh',
        employeeAssignmentId: task.id,
        employeeVersionId: task.id,
        sessionId,
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
        systemInstructions: task.frozen.systemPrompt,
        userRequest: task.question,
        bootstrapConversation: '',
        authorizedMemoryContext: '',
        grantedCapabilities: ['model:invoke'],
        skillVersionIds: [],
      }),
      providerSnapshot: task.frozen.provider,
      storageObjects: [],
      nativeSkills: [],
      workDirectory: input.isolation.workDirectory,
      executionEnvironment: {
        ALLRICE_ORGANIZATION_ID: task.organizationId,
        ALLRICE_WORKSPACE_ID: task.workspaceId,
        ALLRICE_OWNER_ID: task.ownerId,
        ALLRICE_RUN_ID: task.runId,
        ALLRICE_JOB_ID: task.jobId,
      },
      signal,
      attempt: input.execution.job.attempt,
      generation: 0,
      maxOutputTokens: 3000,
      tools: [platformTechnicalToolDefinition],
      authorizedToolNames: [platformTechnicalToolName],
      progress: async (request) => {
        signal.throwIfAborted();
        await getPlatformTechnicalExecution(lease);
        if (
          request.kind === 'model' &&
          (request.action === 'start' || request.action === 'finish')
        ) {
          if (
            typeof request.callId !== 'string' ||
            !/^[a-f0-9-]{36}$/.test(request.callId)
          )
            throw new HandlerError(
              'TECHNICAL_PROGRESS_INVALID',
              '诊断调用回执无效',
              false,
            );
          if (request.action === 'start') {
            if (!modelCalls.has(request.callId) && modelCalls.size >= 8)
              throw new HandlerError(
                'TECHNICAL_MODEL_CALL_LIMIT',
                '诊断调用次数已达到本任务限制',
                false,
              );
            modelCalls.add(request.callId);
          }
          const key = `${request.action}:${request.callId}`;
          if (!progressReceipts.has(key)) {
            await appendJobEvent({
              ...lease,
              type: 'harness.native',
              payload: {
                source: 'platform_technical_model_call',
                jobAttempt: lease.attempt,
                callId: request.callId,
                action: request.action,
                outcome:
                  request.action === 'finish' &&
                  ['success', 'error'].includes(String(request.outcome))
                    ? request.outcome
                    : null,
                billingReceipt: false,
                actualCostKnown: false,
              },
            });
            progressReceipts.add(key);
          }
        }
        return { paused: false };
      },
      onToolCall: (call) =>
        executeRiceTool({
          context: input.execution.context,
          capabilities: ['model:invoke'],
          storageRoot: input.isolation.workDirectory,
          technicalTaskLease: lease,
          technicalTaskId: task.id,
          signal,
          call,
        }),
      onEvent: input.onHarnessEvent,
    });
    await recordPlatformTechnicalUsage(lease, result.usage, {
      usageComplete: result.usageComplete === true,
      cacheUsageKnown: result.cacheUsageKnown === true,
    });
    await getPlatformTechnicalExecution(lease);
    if (result.answer.length > 40000)
      throw new HandlerError(
        'TECHNICAL_ANSWER_LIMIT',
        '诊断答复超过限制',
        false,
      );
    return {
      answer: result.answer,
      usage: result.usage,
      usageComplete: result.usageComplete === true,
      cacheUsageKnown: result.cacheUsageKnown === true,
      actualCostKnown: false,
      actualCost: null,
    };
  } catch (error) {
    const usage = getAssistantFailureUsage(error, task.runId, lease.attempt);
    if (usage)
      await recordPlatformTechnicalUsage(lease, usage.usage, {
        usageComplete: false,
        cacheUsageKnown: usage.cacheUsageKnown,
      });
    if (Date.now() >= new Date(task.deadlineAt).getTime())
      throw new HandlerError('JOB_TIMEOUT', '技术诊断任务已超时', false);
    throw error;
  } finally {
    await adapter.close();
  }
}
