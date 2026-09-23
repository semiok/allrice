import type { TaskRuntimeTiming } from '@allrice/contracts';
import styles from './dsh-saas.module.css';

const duration = (ms: number) =>
  `${Math.floor(ms / 60000)} 分 ${Math.floor((ms % 60000) / 1000)} 秒`;
const limit = (ms: number) => (ms === 0 ? '不限制' : `${ms / 60000} 分钟`);
const scopes: Record<string, string> = {
  tenant: '租户',
  user: '用户',
  employee: '员工',
  provider: '模型连接',
};

/** Display only server clock snapshots; the browser never advances a timer. */
export function ChatRunTiming({ timing }: { timing: TaskRuntimeTiming }) {
  return (
    <details className={styles.runTiming} aria-label="本轮运行时间">
      <summary>
        已运行 {duration(timing.activeMs)} · 等待 {duration(timing.waitingMs)}
        {timing.phase === 'waiting' ? ' · 等待中，运行计时暂停' : ''}
      </summary>
      <p>
        任务有效运行时限：{limit(timing.timeoutMs)} · 总历时：
        {duration(timing.wallMs)}
      </p>
      <p>
        策略来源：
        {timing.sources.length
          ? timing.sources
              .map((s) => `${scopes[s.scope] ?? s.scope} ${limit(s.timeoutMs)}`)
              .join('、')
          : '平台默认 1 小时'}
      </p>
      {timing.calls ? (
        <p>
          模型请求尝试 {timing.calls.modelRequests} 次 · 工具调用{' '}
          {timing.calls.toolCalls} 次（仅统计）
          {timing.calls.pending > 0
            ? ` · ${timing.calls.pending} 次调用回执未完成，用量待核对`
            : ''}
        </p>
      ) : (
        <p>调用统计尚无记录</p>
      )}
    </details>
  );
}
