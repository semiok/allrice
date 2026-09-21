'use client';
import type { UserMonthlyQuota } from '@allrice/contracts';
import styles from './monthly-quota.module.css';

export function monthlyQuotaPercent(percent: number) {
  return percent > 0 && percent < 1 ? '<1%' : `${Math.floor(percent)}%`;
}

export function MonthlyQuota({
  data,
  failed,
  onRefresh,
}: {
  data: UserMonthlyQuota | null;
  failed: boolean;
  onRefresh: () => void;
}) {
  return (
    <details className={styles.quota}>
      <summary
        aria-label="账号月额度"
        title="查看 AllRice 内部月额度，不是 Codex 官方订阅额度"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <path d="M5 19a9 9 0 1 1 14 0M12 12l6-6" />
          <circle cx="12" cy="12" r="2" />
        </svg>
        <span className={styles.identity}>
          <span className={styles.name}>{data?.displayName ?? '当前账号'}</span>
          <span className={styles.label}>AllRice 月额度</span>
        </span>
        <span className={styles.balance} aria-live="polite">
          {data
            ? `剩余 ${monthlyQuotaPercent(data.remainingPercent)}`
            : failed
              ? '暂不可用'
              : '读取中…'}
        </span>
      </summary>
      <div className={styles.detail}>
        {data ? (
          <>
            <p>
              本月已记录 {data.usedTokens.toLocaleString('zh-CN')} /{' '}
              {data.monthlyTokenLimit.toLocaleString('zh-CN')} Token
            </p>
            <p>剩余 {data.remainingTokens.toLocaleString('zh-CN')} Token</p>
            <p>重置时间：{new Date(data.resetsAt).toLocaleString('zh-CN')}</p>
            {data.unknownUsageRuns > 0 ? (
              <p>
                有 {data.unknownUsageRuns} 笔用量待核对，余额按已入账用量计算。
              </p>
            ) : null}
          </>
        ) : (
          <p>
            {failed ? '额度读取失败，请刷新或重新登录。' : '正在读取本月用量。'}
          </p>
        )}
        <p>
          当前账号在此工作区的内部月额度，包含已记录的缓存 Token；不是 Codex
          官方订阅余额。其他执行限制仍单独生效。
        </p>
        <button type="button" onClick={onRefresh}>
          刷新额度
        </button>
      </div>
    </details>
  );
}
