import { createHash } from 'node:crypto';
import {
  recordStaticBrowserExecutionFailure,
  type StaticBrowserVerificationRow,
} from '@allrice/database';
import type {
  CloudRunnerBackend,
  CloudRunResult,
} from '../cloud-runner/backend.js';
import { HandlerError, confirmToolFailure } from '../errors.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

function boundedDiagnostic(output: string) {
  // PostgreSQL JSONB cannot store NUL or unpaired UTF-16 surrogates. Keep the
  // digest over the original output while making the readable tail storable.
  const points = Array.from(output, (point) =>
    point === '\0' || (point.length === 1 && /[\uD800-\uDFFF]/u.test(point))
      ? '\uFFFD'
      : point,
  );
  let length = 0;
  let start = points.length;
  while (start > 0 && length + points[start - 1]!.length <= 2000)
    length += points[--start]!.length;
  return points.slice(start).join('');
}

/** Only a fresh, stopped, network-isolated verifier and a durable exact receipt
 * settle failure. Missing cleanup/receipt remains unknown and cannot replay. */
export async function failedStaticBrowserResult(
  input: RiceToolExecutionInput,
  row: StaticBrowserVerificationRow,
  result: CloudRunResult,
  backend: Pick<CloudRunnerBackend, 'stop' | 'cleanup' | 'inspect'>,
) {
  const unknown = () =>
    new HandlerError(
      'STATIC_BROWSER_VERIFICATION_UNCONFIRMED',
      `页面验证结果或清理尚未确认。验证 ${row.id}，执行 ${row.attempt_id}；请查看已有记录，不要重放此执行。`,
      false,
    );
  if (
    !result.stopped ||
    result.reason === 'unknown' ||
    result.reason === 'completed'
  )
    return unknown();
  try {
    if (!(await backend.stop(row.attempt_id))) return unknown();
    await backend.cleanup(row.attempt_id);
    if ((await backend.inspect(row.attempt_id)) !== null) return unknown();
    const failure = await recordStaticBrowserExecutionFailure(row, {
      version: 1,
      verificationId: row.id,
      attemptId: row.attempt_id,
      containerId: result.containerId,
      imageDigest: result.imageDigest ?? '',
      reason: result.reason,
      exitCode: result.exitCode,
      physicalStopConfirmed: true,
      cleanupConfirmed: true,
      outputDigest:
        'sha256:' + createHash('sha256').update(result.output).digest('hex'),
      diagnostic: boundedDiagnostic(result.output),
    });
    const label =
      failure.reason === 'deadline'
        ? '达到执行时限'
        : failure.reason === 'oom'
          ? '超出可用内存'
          : failure.reason === 'output_limit'
            ? '诊断输出超限'
            : failure.reason === 'canceled'
              ? '已取消'
              : `浏览器进程异常退出（${failure.exitCode ?? '未知退出码'}）`;
    const error = new HandlerError(
      failure.reason === 'deadline'
        ? 'STATIC_BROWSER_DEADLINE'
        : 'STATIC_BROWSER_EXECUTION_FAILED',
      `页面验证未完成：${label}。执行已停止并回收，未生成验证通过结论或截图。验证 ${row.id}，执行 ${row.attempt_id}。${failure.diagnostic ? '\n' + failure.diagnostic : ''}`,
      false,
    );
    confirmToolFailure(error, {
      runId: input.context.runId,
      callId: input.call.id,
      toolName: input.call.name,
    });
    return error;
  } catch {
    return unknown();
  }
}
