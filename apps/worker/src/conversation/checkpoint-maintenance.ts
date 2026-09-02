import type {
  ContextCheckpoint,
  EmployeeKernelRequest,
  ExecutionContext,
} from '@allrice/contracts';
import {
  appendJobEvent,
  buildExtractiveContextSummary,
  clearConversationTurn,
  createCheckpointMemoryCandidate,
  effectiveContextTokens,
  estimateConversationTokens,
  listContextCheckpointEvidence,
  recordConversationNativeContext,
  recordConversationUsage,
  saveContextCheckpoint,
  shouldCreateContextCheckpoint,
  type CheckpointMessage,
} from '@allrice/database';

import type {
  HarnessAdapter,
  HarnessExecutionResult,
} from '../harness/adapter.js';
import { buildCheckpointMemoryCandidate } from '../memory-lifecycle.js';
import type { ConversationOwnership } from './turn-lifecycle.js';

function requestContextFromExecution(context: ExecutionContext) {
  return {
    requestId: context.executionId,
    sessionId: context.runId,
    actor: context.delegatedBy,
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    memberships: context.policySnapshot.memberships,
    authenticatedAt: context.startedAt,
  };
}

/**
 * Finishes the active turn and maintains ChatFlow's durable checkpoint.
 *
 * The operation order intentionally mirrors the original Worker path:
 * clear the active turn, persist usage/native pressure, then compact and save
 * a checkpoint only at the resulting safe boundary.
 */
export async function finalizeEmployeeConversationContext(input: {
  ownership: ConversationOwnership;
  ownerId: string;
  executionContext: ExecutionContext;
  employeeId: string;
  kernel: EmployeeKernelRequest;
  result: HarnessExecutionResult;
  adapter: HarnessAdapter;
  checkpoint: ContextCheckpoint | null;
  checkpointMessages: CheckpointMessage[];
  configChecksum: string;
  workflowLease: {
    workerId: string;
    jobId: string;
    leaseToken: string;
    leaseMs: number;
  };
}) {
  let runtime = await clearConversationTurn(input.ownership);
  const applicationEstimatedTokens = estimateConversationTokens(
    [
      input.kernel.bootstrapConversation,
      input.kernel.authorizedMemoryContext,
      input.kernel.userRequest,
    ].join('\n'),
  );
  if (input.result.usage.inputTokens > 0) {
    runtime = await recordConversationUsage({
      ...input.ownership,
      generation: runtime.generation,
      inputTokens: input.result.usage.inputTokens,
      cachedInputTokens: input.result.usage.cachedInputTokens,
      applicationEstimatedTokens,
    });
  }
  if (input.result.nativeContextPressure) {
    runtime = await recordConversationNativeContext({
      ...input.ownership,
      generation: runtime.generation,
      ...input.result.nativeContextPressure,
    });
  }
  const coveredThroughMessageId = input.checkpointMessages.at(-1)?.id ?? null;
  const estimatedTokens =
    input.result.usage.inputTokens > 0
      ? runtime.contextPressureTokens
      : effectiveContextTokens({
          applicationEstimatedTokens,
          observedDynamicTokens: runtime.dynamicContextTokens,
        });
  if (
    runtime.threadId &&
    input.adapter.capabilities.compact &&
    shouldCreateContextCheckpoint({
      estimatedTokens,
      thresholdTokens: runtime.compactThresholdTokens,
      coveredThroughMessageId,
      latestCoveredThroughMessageId:
        input.checkpoint?.coveredThroughMessageId ?? null,
    })
  ) {
    try {
      if (input.adapter.contextStrategy === 'chatflow-managed') {
        if (!input.adapter.compact) {
          throw new Error(
            'Harness advertises managed compaction without an implementation',
          );
        }
        await appendJobEvent({
          ...input.workflowLease,
          type: 'context.compaction.started',
          payload: { source: input.adapter.kind, threadId: runtime.threadId },
        });
        await input.adapter.compact({ threadId: runtime.threadId });
        await appendJobEvent({
          ...input.workflowLease,
          type: 'context.compaction.completed',
          payload: { source: input.adapter.kind, threadId: runtime.threadId },
        });
      }
      const evidence = await listContextCheckpointEvidence({
        organizationId: input.executionContext.organizationId,
        workspaceId: input.executionContext.workspaceId!,
        sessionId: input.ownership.sessionId,
        ownerId: input.ownerId,
      });
      const summary = buildExtractiveContextSummary({
        previousSummary: input.checkpoint?.summary,
        messages: [...evidence, ...input.checkpointMessages],
      });
      const memoryCandidate = buildCheckpointMemoryCandidate(
        input.checkpointMessages,
      );
      const savedCheckpoint = await saveContextCheckpoint({
        ...input.ownership,
        ownerId: input.ownerId,
        harness: input.kernel.harness,
        threadId: runtime.threadId,
        generation: runtime.generation,
        coveredThroughMessageId: coveredThroughMessageId!,
        summary,
        configChecksum: input.configChecksum,
        estimatedTokens,
        messageCount: input.checkpointMessages.length,
      });
      if (memoryCandidate) {
        try {
          await createCheckpointMemoryCandidate(
            requestContextFromExecution(input.executionContext),
            {
              workspaceId: input.executionContext.workspaceId!,
              employeeId: input.employeeId,
              sessionId: input.ownership.sessionId,
              checkpointId: savedCheckpoint.checkpointId,
              content: memoryCandidate,
              sourceLabel: '会话压缩前的用户稳定陈述',
            },
          );
        } catch (error) {
          // The checkpoint itself remains valid. Candidate extraction is best
          // effort and must never block compaction or the user turn.
          console.error('[M5] Checkpoint memory candidate failed', {
            sessionId: input.ownership.sessionId,
            checkpointId: savedCheckpoint.checkpointId,
            message: error instanceof Error ? error.message : 'unknown error',
          });
        }
      }
      await appendJobEvent({
        ...input.workflowLease,
        type: 'context.checkpoint.created',
        payload: {
          source: input.adapter.kind,
          threadId: runtime.threadId,
          estimatedTokens,
          contextStrategy: input.adapter.contextStrategy,
        },
      });
    } catch (error) {
      await appendJobEvent({
        ...input.workflowLease,
        type: 'context.compaction.failed',
        payload: {
          source: input.adapter.kind,
          threadId: runtime.threadId,
          message: error instanceof Error ? error.message : 'unknown error',
        },
      }).catch(() => undefined);
      console.error('[M5] Context checkpoint maintenance failed', {
        sessionId: input.ownership.sessionId,
        runId: input.executionContext.runId,
        message: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
  return runtime;
}
