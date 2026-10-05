import {
  getPlatformTechnicalExecution,
  readPlatformTechnicalDiagnostics,
  getPlatformTechnicalIssue,
  appendPlatformTechnicalReceipt,
  platformTechnicalHealth,
  recordToolBrokerAudit,
} from '@allrice/database';
import { TechnicalDiagnosticInputSchema } from '@allrice/database/technical-contracts';
import { HandlerError } from '../../errors.js';
import type { RiceToolExecutionInput } from '../types.js';

export async function executePlatformTechnicalDiagnostics(
  input: RiceToolExecutionInput,
) {
  try {
    if (!input.technicalTaskLease || !input.technicalTaskId)
      throw new HandlerError(
        'PLATFORM_TECHNICAL_DENIED',
        '平台诊断仅限专属平台任务',
        false,
      );
    const args = TechnicalDiagnosticInputSchema.parse(input.call.arguments);
    input.signal?.throwIfAborted();
    const task = await getPlatformTechnicalExecution(input.technicalTaskLease);
    const context = input.context;
    if (
      task.id !== input.technicalTaskId ||
      task.runId !== context.runId ||
      task.jobId !== context.jobId ||
      task.organizationId !== context.organizationId ||
      task.workspaceId !== context.workspaceId ||
      context.delegatedBy.id !== task.ownerId ||
      context.worker.id !== input.technicalTaskLease.workerId ||
      context.policySnapshot.subjectId !== task.ownerId
    )
      throw new HandlerError(
        'PLATFORM_TECHNICAL_DENIED',
        '平台任务绑定不一致',
        false,
      );
    const principal = {
      ...context,
      actor: { type: 'user' as const, id: task.ownerId },
      requestId: input.call.id,
      sessionId: task.id,
      authenticatedAt: context.startedAt,
      memberships: context.policySnapshot.memberships,
    };
    const [health, workerHealth] = await Promise.all([
      platformTechnicalHealth('web'),
      platformTechnicalHealth('worker'),
    ]);
    const [diagnostics, issue] = await Promise.all([
      readPlatformTechnicalDiagnostics(principal, { health, workerHealth }),
      task.issueId ? getPlatformTechnicalIssue(principal, task.issueId) : null,
    ]);
    input.signal?.throwIfAborted();
    const receipt = await appendPlatformTechnicalReceipt({
      ...input.technicalTaskLease,
      taskId: task.id,
      callId: input.call.id,
      arguments: args,
      diagnostics,
      issue,
    });
    await recordToolBrokerAudit({
      context,
      toolName: input.call.name,
      metadata: {
        executionMode: 'platform_technical',
        taskId: task.id,
        receiptId: receipt.receiptId,
        nativeCallId: input.call.id,
      },
    });
    return {
      modelContent: JSON.stringify(receipt),
      summary: `平台诊断回执 ${receipt.receiptId}`,
      itemCount: 1,
    };
  } catch (error) {
    await recordToolBrokerAudit({
      context: input.context,
      toolName: input.call.name,
      decision: 'denied',
      reason: 'platform_technical_denied',
      metadata: { nativeCallId: input.call.id },
    }).catch(() => undefined);
    throw error;
  }
}
