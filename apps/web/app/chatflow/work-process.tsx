'use client';

import { useState, type ReactNode } from 'react';
import type { TaskRuntimeTiming } from '@allrice/contracts';
import type { NativeExperienceItem } from '../../lib/chatflow/native-experience';
import { summarizeWorkProcess } from '../../lib/chatflow/work-process';
import { DisclosureRow } from './dsh-upstream/DisclosureRow';
import { IconThinkOutline14 } from './dsh-upstream/ProgressIcons';
import reasoning from './dsh-upstream/ReasoningRow.module.css';
import { ChatRunTiming, formatRunDuration } from './run-timing';
import styles from './dsh-saas.module.css';

/** DSH's native disclosure/Think chrome over Allrice's public event summary. */
export function WorkProcess({
  items,
  timing,
  running,
  streaming,
  failed,
  canceled,
  traceStatus,
  onRetry,
  assistantCount,
  assistantAttention,
  children,
}: {
  items: NativeExperienceItem[];
  timing?: TaskRuntimeTiming;
  running: boolean;
  streaming: boolean;
  failed: boolean;
  canceled: boolean;
  traceStatus?: string;
  onRetry: () => void;
  assistantCount: number;
  assistantAttention: number;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const process = summarizeWorkProcess(items);
  const microStatus = running && !streaming;
  const waiting = timing?.phase === 'waiting';
  const title = microStatus
    ? waiting
      ? '等待处理…'
      : process.active
        ? '执行中…'
        : '思考中…'
    : failed
      ? '未完成'
      : canceled
        ? '已停止'
        : '工作过程';
  const expandable = Boolean(
    timing ||
    items.length ||
    assistantCount ||
    traceStatus === 'failed' ||
    traceStatus === 'loading',
  );
  if (!expandable && !microStatus) return null;
  const otherFailures = items.filter(
    (item) =>
      item.status === 'failed' &&
      item.kind !== 'tool' &&
      item.kind !== 'search',
  );
  const summary = [
    process.failed + otherFailures.length
      ? `${process.failed + otherFailures.length} 次未成功`
      : undefined,
    traceStatus === 'failed' ? '过程加载失败' : undefined,
    microStatus && !waiting ? process.active : undefined,
    timing ? `总耗时 ${formatRunDuration(timing.wallMs)}` : undefined,
    process.total ? `${process.total} 次操作` : undefined,
    !running && process.pending ? `${process.pending} 次结果未确认` : undefined,
    assistantCount
      ? `${assistantCount} 个助手${assistantAttention ? `，${assistantAttention} 个需关注` : ''}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <section
      className={`${reasoning.root} ${styles.workProcess}`}
      aria-label="工作过程"
      data-state={microStatus && !waiting ? 'running' : 'ok'}
    >
      <DisclosureRow
        icon={
          <span
            className={
              microStatus && !waiting ? styles.processPulse : undefined
            }
            aria-hidden
          >
            <IconThinkOutline14 />
          </span>
        }
        title={title}
        open={expanded}
        expandable={expandable}
        expandOnRowClick
        rowClassName={reasoning.row}
        leadingClassName={reasoning.leading}
        titleClassName={`${reasoning.title} ${microStatus ? styles.processStatus : ''}`}
        chevronClassName={reasoning.chevron}
        onToggle={() => setExpanded((value) => !value)}
        collapsedContent={
          summary ? (
            <>
              <span className={reasoning.separator} aria-hidden />
              <span className={reasoning.summary} title={summary}>
                {summary}
              </span>
            </>
          ) : undefined
        }
      >
        {timing ? <ChatRunTiming timing={timing} /> : null}
        <div className={styles.processDetails}>
          {process.groups.length ? (
            <ul className={styles.processGroups} aria-label="操作分类">
              {process.groups.map((group) => (
                <li key={group.key} data-failed={group.failed > 0 || undefined}>
                  <span>
                    {group.label} · {group.count} 次
                  </span>
                  <small>
                    {[
                      group.failed ? `${group.failed} 次未成功` : undefined,
                      group.pending
                        ? `${group.pending} 次${running ? '进行中' : '结果未确认'}`
                        : undefined,
                      group.waiting ? '等待处理' : undefined,
                      group.completed === group.count ? '已完成' : undefined,
                      group.durationMs !== null
                        ? `累计 ${formatRunDuration(group.durationMs)}`
                        : undefined,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                  {group.errors.map((error) => (
                    <small className={styles.processError} key={error}>
                      {error}
                    </small>
                  ))}
                </li>
              ))}
            </ul>
          ) : null}
          {process.hasThinking ? (
            <p>{microStatus && !process.active ? '思考中…' : '已进行思考'}</p>
          ) : null}
          {process.hasCompaction ? (
            <p>
              {otherFailures.some((item) => item.kind === 'compaction')
                ? '对话记录整理未完成'
                : '整理对话记录'}
            </p>
          ) : null}
          {otherFailures
            .filter((item) => item.kind !== 'compaction')
            .map((item) => (
              <p key={item.id}>{item.title}：未完成</p>
            ))}
          {traceStatus === 'failed' ? (
            <button
              className={styles.nativeTraceRetry}
              onClick={onRetry}
              type="button"
            >
              过程加载失败，点击重试
            </button>
          ) : traceStatus === 'loading' && !items.length ? (
            <p>加载过程…</p>
          ) : null}
        </div>
        {children}
      </DisclosureRow>
    </section>
  );
}
