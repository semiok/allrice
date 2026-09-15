'use client';

import type { CodexSubscriptionQuotaSnapshot } from '@allrice/contracts';
import { useEffect, useState } from 'react';

import styles from './codex-subscription-quota.module.css';

export const codexQuotaFreshnessMs = 5 * 60_000;

function windowLabel(minutes: number | null) {
  if (minutes === null) return '时长未知的窗口';
  if (minutes === 10_080) return '7 天窗口（周额度）';
  if (minutes % 60 === 0) return `${minutes / 60} 小时窗口`;
  return `${minutes} 分钟窗口`;
}

function timeLabel(milliseconds: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(milliseconds));
}

function percent(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: 2,
  }).format(value);
}

/** Account-wide provider observation; never a per-tenant token allocation. */
export function CodexSubscriptionQuota({
  quota,
  now,
}: {
  quota?: CodexSubscriptionQuotaSnapshot | null;
  now?: number;
}) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  useEffect(() => {
    if (now !== undefined) return;
    // Expire the view even when the console has no active authorization poll.
    // This updates only local presentation; it never triggers an account read.
    const timer = setInterval(() => setClock(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [now]);
  const currentTime = now ?? clock;
  const checkedAt = quota ? Date.parse(quota.checkedAt) : Number.NaN;
  const validTime = Number.isFinite(checkedAt) && checkedAt <= currentTime;
  const stale = !validTime || currentTime - checkedAt > codexQuotaFreshnessMs;
  const knownAccount = quota?.accountFingerprint != null;
  const usable = quota?.status !== 'error' && !stale && knownAccount;
  const note = !quota
    ? '尚未读取订阅额度，当前剩余未知。'
    : quota.status === 'error'
      ? '暂时无法读取订阅额度，当前剩余未知。'
      : !knownAccount
        ? '订阅账号绑定尚未核验，当前剩余未知。'
        : stale
          ? '额度快照已过期，当前剩余未知；等待后台重新核对。'
          : quota.buckets.length === 0
            ? '服务未返回额度窗口，当前剩余未知。'
            : null;

  return (
    <section className={styles.card} aria-label="Codex 订阅额度">
      <h3>Codex 订阅额度</h3>
      <p className={styles.explanation}>
        同一订阅账号共享的额度，不是本租户的 Token
        余额；与平台内部月度限制分别计算。
      </p>
      {note ? <p role="status">{note}</p> : null}
      {usable
        ? quota?.buckets.map((bucket, index) => (
            <div className={styles.bucket} key={bucket.limitId ?? index}>
              <h4>{bucket.limitId ?? '默认额度'}</h4>
              {bucket.limitReached === true ? (
                <p className={styles.exhausted}>
                  服务已报告达到使用限制，暂停新的模型调用。
                </p>
              ) : null}
              <ul className={styles.windows}>
                {bucket.windows.map((window) => {
                  const resetPassed =
                    window.resetsAt !== null &&
                    window.resetsAt * 1000 <= currentTime;
                  const available =
                    window.status === 'available' &&
                    window.usedPercent !== null &&
                    !resetPassed;
                  const exhausted = available && window.usedPercent === 100;
                  return (
                    <li key={window.slot}>
                      <span>{windowLabel(window.windowDurationMins)}</span>
                      <strong
                        className={exhausted ? styles.exhausted : undefined}
                      >
                        {available
                          ? exhausted
                            ? '已耗尽'
                            : `剩余 ${percent(100 - window.usedPercent!)}%`
                          : '剩余额度未知'}
                      </strong>
                      {available ? (
                        <span>已用 {percent(window.usedPercent!)}%</span>
                      ) : null}
                      {resetPassed ? (
                        <small>
                          已到上次重置时间，等待重新核对；不视为已恢复。
                        </small>
                      ) : window.resetsAt !== null ? (
                        <small>
                          重置：{timeLabel(window.resetsAt * 1000)}（北京时间）
                        </small>
                      ) : (
                        <small>重置时间未知</small>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        : null}
      <p className={styles.checked}>
        后台核对时间：
        {validTime ? `${timeLabel(checkedAt)}（北京时间）` : '尚未核对'}
      </p>
    </section>
  );
}
