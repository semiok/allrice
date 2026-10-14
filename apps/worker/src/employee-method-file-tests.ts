import { z } from 'zod';
import {
  EmployeeMethodFileStepSchema,
  type ExecutionContext,
} from '@allrice/contracts';
import {
  createEmployeeMethodFileOperation,
  getEmployeeMethodTest,
  claimMethodFileExecution,
  RuntimePolicyError,
  DataAccessError,
} from '@allrice/database';
import { LocalStorageAdapter } from '@allrice/storage';
import { runCloudCommandOperation } from './cloud-runner/executor.js';
import type {
  HarnessToolDefinition,
  HarnessToolCall,
  HarnessToolResult,
} from './harness/adapter.js';

export const employeeMethodFileTools: HarnessToolDefinition[] = [
  {
    name: 'platform.employee.method.step',
    description:
      'Execute the selected candidate on the fixed isolated file sample.',
    inputSchema: z.toJSONSchema(EmployeeMethodFileStepSchema),
  },
];

export async function executeEmployeeMethodFileStep(input: {
  context: ExecutionContext;
  testId: string;
  leaseToken: string;
  jobAttempt: number;
  call: HarnessToolCall;
  signal: AbortSignal;
  storageRoot: string;
  onUnverified: (code: string) => void;
}): Promise<HarnessToolResult> {
  if (input.call.name !== 'platform.employee.method.step')
    throw new Error('method_test_tool_not_allowed');
  try {
    input.signal.throwIfAborted();
    const storage = new LocalStorageAdapter(input.storageRoot);
    const operation = await createEmployeeMethodFileOperation({
      context: input.context,
      storage,
      arguments: input.call.arguments,
      callId: input.call.id,
      leaseToken: input.leaseToken,
      jobAttempt: input.jobAttempt,
    });
    const first = await claimMethodFileExecution(
      input.context,
      operation.snapshot.binding.attempt.operationId,
    );
    const result = first
      ? await runCloudCommandOperation(operation, {
          storage,
          signal: input.signal,
        })
      : {
          operationId: operation.snapshot.binding.attempt.operationId,
          status: (
            await operation.ledger.readOperation(
              operation.snapshot.binding.task.scope,
              operation.snapshot.binding.attempt.operationId,
            )
          ).status,
          artifacts: [],
          output: '',
          reconciled: true,
        };
    if (first && result.status !== 'succeeded')
      input.onUnverified(`METHOD_FILE_${result.status.toUpperCase()}`);
    const test = await getEmployeeMethodTest(
      {
        organizationId: input.context.organizationId,
        workspaceId: input.context.workspaceId,
        actor: { type: 'user', id: input.context.policySnapshot.subjectId },
        requestId: input.call.id,
      },
      input.testId,
    );
    return {
      modelContent: JSON.stringify({
        ...result,
        assertion: test.assertion,
        files: test.files,
        coverage: test.coverage,
      }),
      summary: `隔离文件步骤 · ${result.status}`,
      itemCount: result.artifacts.length,
    };
  } catch (error) {
    if (input.signal.aborted) throw error;
    const code =
      error instanceof Error
        ? error.message
        : 'METHOD_FILE_EXECUTION_UNVERIFIED';
    if (
      ![
        'method_test_wrong_stage',
        'method_test_already_failed',
        'method_test_step_already_recorded',
      ].includes(code)
    )
      input.onUnverified(code);
    if (!(
      error instanceof RuntimePolicyError ||
      error instanceof DataAccessError ||
      error instanceof z.ZodError
    ))
      throw error;
    return {
      modelContent: JSON.stringify({
        status: 'failed',
        code: error instanceof z.ZodError ? 'invalid_arguments' : error.message,
        instruction:
          '该步骤没有成功。保留本测试结果，不要替候选修正或重放任务来获取通过。',
      }),
      summary: '隔离文件步骤未通过',
    };
  }
}
