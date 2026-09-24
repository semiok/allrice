import type { TaskRuntimeTiming } from '@allrice/contracts';
import styles from './dsh-saas.module.css';

export function formatRunDuration(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (ms > 0 && seconds === 0) return '不到 1 秒';
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** Display only server clock snapshots; the browser never advances a timer. */
export function ChatRunTiming({ timing }: { timing: TaskRuntimeTiming }) {
  return (
    <p className={styles.runTiming} aria-label="本轮运行时间">
      总耗时 {formatRunDuration(timing.wallMs)}
      {timing.phase === 'waiting'
        ? ` · 累计等待 ${formatRunDuration(timing.waitingMs)}`
        : ''}
    </p>
  );
}
