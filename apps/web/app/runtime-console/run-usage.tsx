import type { RuntimeRunUsage } from '@allrice/contracts';
import styles from './runtime-console.module.css';

const format = (value: number | null) =>
  value === null ? '未知' : value.toLocaleString('en-US');

export function RunUsageSummary({
  usage,
  runStatus,
}: {
  usage?: RuntimeRunUsage | null;
  runStatus: string;
}) {
  const active = ['queued', 'running', 'waiting_approval'].includes(runStatus);
  if (!usage || usage.receiptCount === 0) {
    return (
      <div className={styles.turnUsage} aria-label="本轮 Token 用量">
        <span>总消耗：—</span>
        <span>其中缓存：—</span>
        <small>
          {active ? '运行中，用量待结算' : '暂无用量回执（不代表 0）'}
        </small>
      </div>
    );
  }
  const complete = usage.usageComplete && !active;
  return (
    <div className={styles.turnUsage} aria-label="本轮 Token 用量">
      <span>
        {complete ? '总消耗' : '已确认累计'}：
        <strong>{format(usage.totalTokens)}</strong> Token
      </span>
      <span>
        其中缓存：<strong>{format(usage.cachedInputTokens)}</strong>
      </span>
      <span>输入（含缓存）：{format(usage.inputTokens)}</span>
      <span>输出：{format(usage.outputTokens)}</span>
      {!complete && (
        <small>
          {active ? '运行中，用量待结算' : '用量未完整，以上仅为已确认部分'}
        </small>
      )}
      {!usage.cacheUsageKnown && <small>缓存明细未完整</small>}
      {usage.attemptCount > 1 && (
        <small>含 {usage.attemptCount} 次执行尝试</small>
      )}
      <small>总量＝输入＋输出；缓存已包含在输入中</small>
    </div>
  );
}
