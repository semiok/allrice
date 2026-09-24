'use client';

import { useState, type ReactNode } from 'react';
import {
  IconThinkOutlineRegular,
  IconSearchOutlineRegular,
  IconGlobeOutlineRegular,
  IconBrowseOutlineRegular,
  IconEditOutlineRegular,
  IconCodeOutlineRegular,
  IconApiOutlineRegular,
  IconAgentPresetOutlineRegular,
  IconPlanOutlineRegular,
  IconQuestionOutlineRegular,
  IconSparkleRegular,
  IconFolderOpenOutlineRegular,
  IconDataOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { TaskRuntimeTiming } from '@allrice/contracts';
import type { NativeExperienceItem } from '../../lib/chatflow/native-experience';
import {
  summarizeWorkProcess,
  type WorkProcessCategory,
} from '../../lib/chatflow/work-process';
import { DisclosureRow } from './dsh-upstream/DisclosureRow';
import { IconThinkOutline14 } from './dsh-upstream/ProgressIcons';
import reasoning from './dsh-upstream/ReasoningRow.module.css';
import { formatRunDuration } from './run-timing';
import styles from './dsh-saas.module.css';

const stepIcons: Record<WorkProcessCategory, ReactNode> = {
  think: <IconThinkOutlineRegular />,
  search: <IconSearchOutlineRegular />,
  market: <IconGlobeOutlineRegular />,
  analyze: <IconDataOutlineRegular />,
  read: <IconBrowseOutlineRegular />,
  find: <IconFolderOpenOutlineRegular />,
  write: <IconEditOutlineRegular />,
  edit: <IconCodeOutlineRegular />,
  execute: <IconApiOutlineRegular />,
  browse: <IconBrowseOutlineRegular />,
  skill: <IconSparkleRegular />,
  collaborate: <IconAgentPresetOutlineRegular />,
  question: <IconQuestionOutlineRegular />,
  organize: <IconRefreshOutlineRegular />,
  plan: <IconPlanOutlineRegular />,
  tool: <IconSparkleRegular />,
};
const noop = () => {};

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
  const summary = [
    process.failed ? `${process.failed} 次未成功` : undefined,
    traceStatus === 'failed' ? '过程加载失败' : undefined,
    microStatus && !waiting ? process.active : undefined,
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
        keepContentWhenOpen
        rowClassName={reasoning.row}
        leadingClassName={reasoning.leading}
        titleClassName={`${reasoning.title} ${microStatus ? styles.processStatus : ''}`}
        chevronClassName={reasoning.chevron}
        onToggle={() => setExpanded((value) => !value)}
        collapsedContent={
          <>
            {timing ? (
              <>
                <span className={reasoning.separator} aria-hidden />
                <span
                  className={styles.processTiming}
                  aria-label="本轮运行时间"
                >
                  总耗时 {formatRunDuration(timing.wallMs)}
                </span>
              </>
            ) : null}
            {summary ? (
              <>
                <span className={reasoning.separator} aria-hidden />
                <span className={reasoning.summary} title={summary}>
                  {summary}
                </span>
              </>
            ) : null}
          </>
        }
      >
        <div className={styles.processDetails}>
          {process.steps.length ? (
            <ul className={styles.processSteps} aria-label="工作步骤">
              {process.steps.map((step) => {
                const pending =
                  ['started', 'updated'].includes(step.status) &&
                  step.category !== 'plan';
                const status =
                  step.status === 'failed'
                    ? `未成功${step.error ? `：${step.error}` : ''}`
                    : step.status === 'info'
                      ? '等待处理'
                      : pending
                        ? running
                          ? '进行中'
                          : '结果未确认'
                        : undefined;
                return (
                  <li
                    key={step.id}
                    data-category={step.category}
                    data-failed={step.status === 'failed' || undefined}
                  >
                    <DisclosureRow
                      icon={
                        <span
                          className={
                            pending && running ? styles.processPulse : undefined
                          }
                          aria-hidden
                        >
                          {stepIcons[step.category]}
                        </span>
                      }
                      title={step.label}
                      open={false}
                      expandable={false}
                      onToggle={noop}
                      rowClassName={styles.processStepRow}
                      titleClassName={styles.processStepLabel}
                      collapsedContent={
                        <>
                          <span className={reasoning.separator} aria-hidden />
                          <span className={styles.processStepDescription}>
                            {step.description}
                          </span>
                        </>
                      }
                    />
                    {status ? (
                      <small className={styles.processStepStatus}>
                        {status}
                      </small>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
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
