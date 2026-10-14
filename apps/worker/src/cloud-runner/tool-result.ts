import { HandlerError, confirmToolFailure } from '../errors.js';
import type { RiceToolExecutionInput } from '../tool-broker/types.js';

/** Only the executor's durable outcome and confirmed cleanup settle a tool.
 * JSON text, exit codes alone and an uncertain operation never authorize replay. */
export function requireSuccessfulCloudCommand(
  input: RiceToolExecutionInput,
  result: {
    status: string;
    reason?: string;
    stopped?: boolean;
    cleanupConfirmed?: boolean;
    exitCode?: number | null;
    output?: string;
  },
) {
  if (result.status === 'succeeded') return;
  if (
    !['failed', 'canceled'].includes(result.status) ||
    result.reason === 'unknown' ||
    !result.stopped ||
    !result.cleanupConfirmed
  )
    throw new HandlerError(
      'CLOUD_RESULT_UNKNOWN',
      '云端计算结果或清理尚未确认；需核对原操作，不能重放或切换到本地重跑。',
      false,
    );
  const [code, message] =
    result.reason === 'output_limit'
      ? [
          'CLOUD_OUTPUT_LIMIT',
          '云端计算已停止：标准输出超出本次 outputBytes 上限。只打印有限字段和样本，将完整数据写入声明的成果文件；不要再次输出整张表或全部表头。',
        ]
      : result.reason === 'deadline'
        ? [
            'CLOUD_EXECUTION_TIMEOUT',
            '云端计算已停止：达到本次执行时限。读取 Excel 时先核实实际非空范围，限定行列并分批处理；不要遍历工作表声明的整片空白区域。',
          ]
        : result.status === 'canceled'
          ? [
              'CLOUD_EXECUTION_CANCELED',
              '云端计算已取消并确认停止，未交付成果。',
            ]
          : [
              'CLOUD_EXECUTION_FAILED',
              `云端计算已停止但未完成（退出码 ${result.exitCode ?? '未知'}），未交付成果。${result.output ? `\n${result.output.slice(-2000)}` : ''}`,
            ];
  const error = new HandlerError(code!, message!, false);
  confirmToolFailure(error, {
    runId: input.context.runId,
    callId: input.call.id,
    toolName: input.call.name,
  });
  throw error;
}
