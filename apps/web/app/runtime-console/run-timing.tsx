import type { TaskRuntimeTiming } from '@allrice/contracts';
import styles from './runtime-console.module.css';

const duration = (ms: number) =>
  `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;
const limit = (ms: number) => (ms === 0 ? '不限制' : `${ms / 60000} 分钟`);
const scopes: Record<string, string> = {
  tenant: '租户',
  user: '用户',
  employee: '员工',
  provider: '模型连接',
};
export function RunTimingSummary({
  timing,
}: {
  timing?: TaskRuntimeTiming | null;
}) {
  if (!timing) return null; // Historical Run: no invented elapsed/call data.
  return (
    <div className={styles.turnUsage} aria-label="本轮运行保护与统计">
      <span>任务时限：{limit(timing.timeoutMs)}</span>
      <span>活跃：{duration(timing.activeMs)}</span>
      <span>等待：{duration(timing.waitingMs)}</span>
      <span>总历时：{duration(timing.wallMs)}</span>
      {timing.phase === 'waiting' && <small>等待中，活跃计时暂停</small>}
      <small>
        策略来源：
        {timing.sources.length
          ? timing.sources
              .map((s) => `${scopes[s.scope] ?? s.scope} ${limit(s.timeoutMs)}`)
              .join('、')
          : '平台默认 1 小时'}
      </small>
      {timing.calls ? (
        <>
          <span>原生模型请求尝试：{timing.calls.modelRequests}</span>
          <span>工具调用：{timing.calls.toolCalls}</span>
          {!!timing.calls.pending && (
            <small>待完成回执：{timing.calls.pending}（不代表 0 消耗）</small>
          )}
          <small>调用次数仅统计；不是 Codex 官方订阅额度</small>
        </>
      ) : (
        <small>原生调用统计尚无记录</small>
      )}
    </div>
  );
}
