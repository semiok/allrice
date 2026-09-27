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
  if (expanded)
    return (
      <section
        className={styles.usage}
        aria-label={observing ? '账号使用情况' : '账号月额度'}
      >
        <div className={styles.usageBody}>
          <header>
            <span>{observing ? '本月用量' : 'AllRice 月额度'}</span>
            <button type="button" onClick={onRefresh}>
              {observing ? '刷新用量' : '刷新额度'}
            </button>
          </header>
          <p className={styles.value} aria-live="polite">
            {data
              ? data.usedTokens.toLocaleString('zh-CN')
              : failed
                ? '暂不可用'
                : '读取中…'}
            {data && <small>Token</small>}
          </p>
          {data ? (
            <dl>
              {providerLabel && (
                <>
                  <dt>模型服务</dt>
                  <dd>{providerLabel}</dd>
                </>
              )}
              {observing ? (
                <>
                  <dt>其中缓存</dt>
                  <dd>
                    {data.cachedInputTokens == null
                      ? '待核对'
                      : `${data.cachedInputTokens.toLocaleString('zh-CN')} Token`}
                  </dd>
                </>
              ) : (
                <>
                  <dt>月额度</dt>
                  <dd>
                    {data.monthlyTokenLimit.toLocaleString('zh-CN')} Token
                  </dd>
                  <dt>剩余</dt>
                  <dd>
                    {data.remainingTokens.toLocaleString('zh-CN')} Token ·{' '}
                    {monthlyQuotaPercent(data.remainingPercent)}
                  </dd>
                </>
              )}
              <dt>{observing ? '下个统计周期' : '重置时间'}</dt>
              <dd>{new Date(data.resetsAt).toLocaleString('zh-CN')}</dd>
            </dl>
          ) : (
            failed && <p>额度读取失败，请刷新或重新登录。</p>
          )}
          {!!data?.unknownUsageRuns && (
            <p>有 {data.unknownUsageRuns} 笔用量待核对，以上为已记录用量。</p>
          )}
        </div>
        <details className={styles.explanation}>
          <summary>用量如何计算</summary>
          <p>
            {observing
              ? '这里只统计当前账号在此工作区已记录的用量，缓存已包含在总量中，并非 Codex 官方订阅余额。Codex 订阅不因内部 Token 上限或回执缺失阻断聊天；并发、超时与执行权限仍生效。'
              : '这是当前账号在此工作区的内部月额度，包含已记录的缓存 Token；不是 Codex 官方订阅余额。余额按已入账用量计算，其他执行限制仍单独生效。'}
          </p>
        </details>
      </section>
    );
  return (
    <details
      className={`${styles.quota} ${expanded ? styles.expanded : ''}`}
      open={expanded || undefined}
    >
      <summary
        aria-label={observing ? '账号使用情况' : '账号月额度'}
        title={
          observing
            ? '查看已记录用量；Token 与费用仅统计'
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
                  ? '上述为已知小计，不阻断后续聊天。'
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
            ? '当前账号在此工作区的用量统计。Token、模型和工具调用次数、费用仅统计，回执缺失不阻断任务。任务时限与无进展保护仍生效。'
            : '当前账号在此工作区的内部月额度，包含已记录的缓存 Token；不是 Codex 官方订阅余额。其他执行限制仍单独生效。'}
        </p>
        <button type="button" onClick={onRefresh}>
          {observing ? '刷新用量' : '刷新额度'}
        </button>
      </div>
    </details>
  );
}
