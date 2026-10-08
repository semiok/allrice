import { HandlerError, confirmToolFailure } from '../errors.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

// These are the Bridge's explicit pre-execution failures. A code alone is not
// proof: the committed outcome must also confirm failure with no effects, and
// must not contain a contradictory execution result.
const preflightCodes = new Set([
  'TOOLCHAIN_CHANGED',
  'ISOLATION_UNAVAILABLE',
  'UNSAFE_DAEMON_SOCKET',
  'INPUT_VERSION_CHANGED',
  'INPUT_LIMIT',
  'INPUT_DOWNLOAD_UNAVAILABLE',
  'EXECUTION_REVOKED',
]);

export function assertLocalPythonPreflight(
  input: RiceToolExecutionInput,
  settled: { status: string; effects?: string; evidence: unknown },
  purpose: 'PYTHON' | 'OFFICE',
) {
  if (
    settled.status !== 'failed' ||
    settled.effects !== 'none' ||
    !settled.evidence ||
    typeof settled.evidence !== 'object'
  )
    return;
  const evidence = settled.evidence as {
    output?: unknown;
    errorCode?: unknown;
  };
  if (
    evidence.output !== undefined ||
    typeof evidence.errorCode !== 'string' ||
    !preflightCodes.has(evidence.errorCode)
  )
    return;
  const error = new HandlerError(
    `${purpose}_PREFLIGHT_FAILED`,
    `本地 ${purpose === 'OFFICE' ? 'Office' : 'Python'} 执行前校验失败（${evidence.errorCode}），已确认未执行。请检查输入或执行环境；当前调用不会重放或换端。`,
    false,
  );
  confirmToolFailure(error, {
    runId: input.context.runId,
    callId: input.call.id,
    toolName: input.call.name,
  });
  throw error;
}
