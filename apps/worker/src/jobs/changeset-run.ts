import { randomUUID } from 'node:crypto';
import { LocalStorageAdapter } from '@allrice/storage';
import {
  createChangesetOperation,
  readChangesetEvidence,
  getDatabase,
  taskDeadlineOpen,
} from '@allrice/database';
import type { ClaimedJobHandlerInput } from '../job-runner.js';
import { HandlerError } from '../errors.js';

/** A typed action request uses the existing Worker/Run, without invoking a model. */
export async function executeChangesetRun({
  execution,
  signal,
}: ClaimedJobHandlerInput) {
  const created = await createChangesetOperation(
    execution.context,
    new LocalStorageAdapter(
      process.env.ALLRICE_STORAGE_ROOT ?? '.local/storage',
    ),
  );
  const scope = created.snapshot.binding.task.scope;
  try {
    while (true) {
      if (
        signal.aborted ||
        !(await taskDeadlineOpen(
          getDatabase(),
          execution.context.runId,
          created.deadlineAt,
        ))
      )
        throw new HandlerError(
          'CHANGESET_CANCELED',
          '文件任务停止；请查看逐文件执行记录。',
          false,
        );
      await created.ledger.expireLeases(scope, execution.context.runId);
      const state = await created.ledger.readOperation(
        scope,
        created.snapshot.binding.attempt.operationId,
      );
      if (state.status === 'waiting_user') {
        const [approval] = await getDatabase()<{ inactive: boolean }[]>`
          select (runtime_revoked_at is not null or runtime_expires_at<=clock_timestamp() or runtime_response->>'decision'='rejected') is true as inactive
          from allrice_approval_requests where resource_id=${state.binding.attempt.operationId}
            and resource_type='runtime_operation' and organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}`;
        if (!approval || approval.inactive)
          throw new HandlerError(
            'CHANGESET_APPROVAL_CLOSED',
            '文件操作授权已拒绝、撤销或过期，未执行的文件保持不变。',
            false,
          );
      }
      if (
        ['succeeded', 'failed', 'partial', 'canceled', 'unknown'].includes(
          state.status,
        )
      ) {
        const evidence = await readChangesetEvidence(
          getDatabase(),
          {
            actor: { type: 'user', id: execution.job.ownerId },
            organizationId: scope.organizationId,
            workspaceId: scope.workspaceId,
          },
          execution.context.runId,
        );
        if (
          state.status !== 'succeeded' ||
          !evidence.result ||
          evidence.result.files.length !==
            created.payload.arguments.files.length ||
          evidence.result.files.some(
            (f, i) =>
              f.status !== 'applied' ||
              f.path !== created.payload.arguments.files[i]?.path ||
              f.beforeChecksum !==
                (created.payload.arguments.files[i]?.before?.checksum ??
                  null) ||
              f.afterChecksum !==
                (created.payload.arguments.files[i]?.after?.checksum ?? null),
          )
        )
          throw new HandlerError(
            `CHANGESET_${state.status.toUpperCase()}`,
            '文件任务未全部完成；已确认、未执行和结果未知的文件分别保留在工作台。',
            false,
          );
        return {
          answer: `${created.payload.arguments.direction === 'restore' ? '已恢复' : '已应用'} ${evidence.result.files.length} 个文件。结果以 Bridge 逐文件回执为准；没有自动运行项目代码，后续测试仍需单独授权。`,
          citations: [],
          usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
          modelInvoked: false,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  } catch (error) {
    await created.ledger
      .cancelRoot(scope, execution.context.runId, randomUUID())
      .catch(() => undefined);
    throw error;
  }
}
