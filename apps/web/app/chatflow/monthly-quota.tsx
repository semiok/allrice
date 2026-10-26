'use client';
import { useState } from 'react';
import type { UserMonthlyQuota } from '@allrice/contracts';
import {
  Button,
  DisclosureRow,
  IconInfoOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { shortDateTime } from '../../lib/chatflow/short-date-time';
import styles from './monthly-quota.module.css';

export function monthlyQuotaPercent(percent: number) {
  return percent > 0 && percent < 1 ? '<1%' : `${Math.floor(percent)}%`;
}

const amount = (value: number) => value.toLocaleString('zh-CN');

/** Settings → 账号与用量: the one place usage figures appear, never as "Token". */
export function MonthlyQuota({
  data,
  failed,
  onRefresh,
}: {
  data: UserMonthlyQuota | null;
  failed: boolean;
  onRefresh: () => void;
}) {
  const [explained, setExplained] = useState(false);
  const observing = data?.codexTokenPolicy === 'observe';
  return (
    <section
      className={styles.usage}
      aria-label={observing ? '账号使用情况' : '账号月额度'}
    >
      <div className={styles.usageBody}>
        <header>
          <span>{observing ? '本月用量' : '每月额度'}</span>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            {observing ? '刷新用量' : '刷新额度'}
          </Button>
        </header>
        <p className={styles.value} aria-live="polite">
          {data ? (
            <>
              <small>本月已用</small>
              {amount(data.usedTokens)}
            </>
          ) : failed ? (
            '暂不可用'
          ) : (
            '读取中…'
          )}
        </p>
        {data ? (
          <dl>
            {observing ? (
              <>
                <dt>其中缓存</dt>
                <dd>
                  {data.cachedInputTokens == null
                    ? '还在统计'
                    : amount(data.cachedInputTokens)}
                </dd>
              </>
            ) : (
              <>
                <dt>本月上限</dt>
                <dd>{amount(data.monthlyTokenLimit)}</dd>
                <dt>剩余</dt>
                <dd>
                  {amount(data.remainingTokens)} ·{' '}
                  {monthlyQuotaPercent(data.remainingPercent)}
                </dd>
              </>
            )}
            <dt>{observing ? '下个统计周期' : '重置时间'}</dt>
            <dd>{shortDateTime(data.resetsAt)}</dd>
          </dl>
        ) : (
          failed && <p>用量暂时读不到，请稍后刷新，或重新登录。</p>
        )}
        {!!data?.unknownUsageRuns && (
          <p>
            有 {data.unknownUsageRuns}{' '}
            次任务的用量还在统计，上面是已统计的部分。
          </p>
        )}
      </div>
      <div className={styles.explanation}>
        <DisclosureRow
          icon={<IconInfoOutlineRegular size={14} />}
          title="用量如何计算"
          open={explained}
          expandable
          expandOnRowClick
          onToggle={() => setExplained((value) => !value)}
          titleClassName={styles.explanationTitle}
        >
          {explained && (
            <p>
              {observing
                ? '这里统计你在这个工作区本月的用量，没有月度上限。同时进行的任务数和单个任务的时长仍有限制，长时间没有进展的任务会自动停止。'
                : '这是你在这个工作区每月可用的额度，剩余按已统计的用量计算，到重置时间恢复。单个任务另有时长限制。'}
            </p>
          )}
        </DisclosureRow>
      </div>
    </section>
  );
}
