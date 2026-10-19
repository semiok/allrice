import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { HandlerError, isConfirmedToolFailure } from '../errors.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';
import { requireSuccessfulCloudCommand } from './tool-result.js';
const identity = () => ({
  runId: randomUUID(),
  callId: randomUUID(),
  toolName: 'python.execute',
});
function attempt(result: Parameters<typeof requireSuccessfulCloudCommand>[1]) {
  const call = identity();
  const input = {
    context: { runId: call.runId },
    call: { id: call.callId, name: call.toolName },
  } as RiceToolExecutionInput;
  let error: unknown;
  try {
    requireSuccessfulCloudCommand(input, result);
  } catch (cause) {
    error = cause;
  }
  return { error, call };
}
const rejection = () => ({
  status: 'failed',
  reason: 'failed',
  exitCode: 0,
  stopped: true,
  cleanupConfirmed: true,
  errorCode: 'project_output_parent_stale',
});
describe('cloud publication rejection stays an exact confirmed native tool failure', () => {
  it.each(['failed', 'completed'])(
    'preserves stale-parent meaning with logical/physical %s reason',
    (reason) => {
      const f = attempt({ ...rejection(), reason });
      expect(f.error).toBeInstanceOf(HandlerError);
      expect(f.error).toMatchObject({
        code: 'project_output_parent_stale',
        retryable: false,
      });
      expect((f.error as Error).message).toContain(
        'project_output_parent_stale',
      );
      expect((f.error as Error).message).toContain('云端计算已完成');
      expect((f.error as Error).message).toContain('未发布新版');
      expect((f.error as Error).message).toContain('读取当前最新版本');
      expect((f.error as Error).message).toContain('不要自动重执行');
      expect(isConfirmedToolFailure(f.error, f.call)).toBe(true);
      for (const replacement of [
        { runId: randomUUID() },
        { callId: randomUUID() },
        { toolName: 'workspace.project' },
      ])
        expect(
          isConfirmedToolFailure(f.error, { ...f.call, ...replacement }),
        ).toBe(false);
    },
  );
  it.each([
    { status: 'unknown' },
    { status: 'running' },
    { reason: 'unknown' },
    { stopped: false },
    { cleanupConfirmed: false },
    { cleanupConfirmed: undefined },
    { externalOutcomeUnknown: true },
  ])('keeps unconfirmed result %j unknown and unconfirmed', (override) => {
    const f = attempt({ ...rejection(), ...override });
    expect(f.error).toMatchObject({
      code: 'CLOUD_RESULT_UNKNOWN',
      retryable: false,
    });
    expect(isConfirmedToolFailure(f.error, f.call)).toBe(false);
    expect((f.error as Error).message).toContain('不能重放');
  });
  it('does not mislabel a nonzero physical exit as completed computation', () => {
    const f = attempt({ ...rejection(), exitCode: 1 });
    expect(f.error).toMatchObject({
      code: 'CLOUD_EXECUTION_FAILED',
      retryable: false,
    });
    expect((f.error as Error).message).not.toContain('云端计算已完成');
  });
  it('keeps the existing generic failed path and successful return intact', () => {
    const failed = attempt({
      ...rejection(),
      errorCode: 'ANOTHER_FAILURE',
      exitCode: 1,
    });
    expect(failed.error).toMatchObject({ code: 'CLOUD_EXECUTION_FAILED' });
    expect(isConfirmedToolFailure(failed.error, failed.call)).toBe(true);
    expect(
      attempt({
        status: 'succeeded',
        reason: 'completed',
        exitCode: 0,
        stopped: true,
        cleanupConfirmed: true,
      }).error,
    ).toBeUndefined();
  });
});
