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
  expanded = false,
  providerLabel,
}: {
  data: UserMonthlyQuota | null;
  failed: boolean;
  onRefresh: () => void;
  expanded?: boolean;
  providerLabel?: string;
}) {
  const observing = data?.codexTokenPolicy === 'observe';
  return (
    <details
      className={`${styles.quota} ${expanded ? styles.expanded : ''}`}
      open={expanded || undefined}
    >
      <summary
        aria-label={observing ? '账号使用情况' : '账号月额度'}
        title={
          observing
            ? '查看已记录用量；Codex 订阅 Token 仅统计，不作为内部限额'
            : '查看 AllRice 内部月额度，不是 Codex 官方订阅额度'
        }
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
          <span className={styles.account}>
            <span className={styles.name}>
              {data?.displayName ?? '当前账号'}
            </span>
            {providerLabel && (
              <span className={styles.provider} aria-label="模型服务">
                {providerLabel}
              </span>
            )}
          </span>
          <span className={styles.label}>
            {observing ? '本月使用情况' : 'AllRice 月额度'}
          </span>
        </span>
        <span className={styles.balance} aria-live="polite">
          {data
            ? observing
              ? `${data.usedTokens.toLocaleString('zh-CN')} Token`
              : `剩余 ${monthlyQuotaPercent(data.remainingPercent)}`
            : failed
              ? '暂不可用'
              : '读取中…'}
        </span>
      </summary>
      <div className={styles.detail}>
        {data ? (
          <>
            <p>
              本月已记录 {data.usedTokens.toLocaleString('zh-CN')}
              {observing
                ? ''
                : ` / ${data.monthlyTokenLimit.toLocaleString('zh-CN')}`}{' '}
              Token
            </p>
            {observing ? (
              <p>
                其中缓存：
                {data.cachedInputTokens == null
                  ? '待核对'
                  : `${data.cachedInputTokens.toLocaleString('zh-CN')} Token`}
                （包含在总量中）
              </p>
            ) : (
              <p>剩余 {data.remainingTokens.toLocaleString('zh-CN')} Token</p>
            )}
            <p>
              {observing ? '下个统计周期' : '重置时间'}：
              {new Date(data.resetsAt).toLocaleString('zh-CN')}
            </p>
            {data.unknownUsageRuns > 0 ? (
              <p>
                有 {data.unknownUsageRuns} 笔用量待核对，
                {observing
                  ? '上述为已知小计，不阻断 Codex 后续聊天。'
                  : '余额按已入账用量计算。'}
              </p>
            ) : null}
          </>
        ) : (
          <p>
            {failed ? '额度读取失败，请刷新或重新登录。' : '正在读取本月用量。'}
          </p>
        )}
        <p>
          {observing
            ? '当前账号在此工作区的用量统计。Codex 订阅 Token 仅统计，不因内部 Token 上限或回执缺失阻断聊天；不是 Codex 官方订阅余额。并发、超时与执行权限仍生效。'
            : '当前账号在此工作区的内部月额度，包含已记录的缓存 Token；不是 Codex 官方订阅余额。其他执行限制仍单独生效。'}
        </p>
        <button type="button" onClick={onRefresh}>
          {observing ? '刷新用量' : '刷新额度'}
        </button>
      </div>
    </details>
  );
}
