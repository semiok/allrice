import type { TechnicalRecord } from '@allrice/database/technical-contracts';

const reasons: Record<string, string> = {
  deadline: '计算达到执行时限',
  output_limit: '标准输出超出上限',
  failed: '计算未完成',
  canceled: '计算已取消',
  unknown: '结果尚未确认',
};
export function TechnicalFailureDetails({
  record,
}: {
  record: TechnicalRecord;
}) {
  const details = record.failureDetails;
  if (!details) return null;
  return (
    <section aria-label="失败链路详情">
      {record.errorCode === 'DSH_PI_AI_ERROR' && (
        <p>
          模型调用返回通用错误。现有记录未提供可核实的上游状态码或请求
          ID，根因尚未确认；不能据此认定是 Codex 服务故障或排除
          AllRice。此前工具失败单独列出，不代表已确认与最终中断存在因果关系。
        </p>
      )}
      {details.cloud.map((operation) => (
        <p key={operation.operationId}>
          {reasons[operation.reason]} · 操作 {operation.operationId} · 账本状态{' '}
          {operation.status}
          {' · '}退出码 {operation.exitCode ?? '未知'} ·{' '}
          {operation.stopped ? '已确认停止' : '停止未确认'}
          {' · '}
          {operation.cleanupConfirmed ? '已清理' : '清理待确认'}
        </p>
      ))}
      {details.cloudTruncated && <p>仅展示最近 8 个云端异常操作。</p>}
    </section>
  );
}
