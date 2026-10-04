'use client';

import { Children, useState, type ReactNode } from 'react';
import { AssistantMarkdown } from './assistant-markdown';
import type { WorkProgressPart } from '../../lib/chatflow/work-progress';
import {
  DisclosureRow,
  IconThinkOutlineRegular,
  IconSearchOutlineRegular,
  IconGlobeOutlineRegular,
  IconBrowseOutlineRegular,
  IconEditOutlineRegular,
  IconApiOutlineRegular,
  IconAgentPresetOutlineRegular,
  IconPlanOutlineRegular,
  IconQuestionOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconSkillOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconDataOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { TaskRuntimeTiming, WorkbenchArtifact } from '@allrice/contracts';
import type { NativeExperienceItem } from '../../lib/chatflow/native-experience';
import {
  summarizeWorkProcess,
  type WorkProcessCategory,
} from '../../lib/chatflow/work-process';
import { IconThinkOutline14 } from './dsh-upstream/ProgressIcons';
import reasoning from './dsh-upstream/ReasoningRow.module.css';
import { RunElapsedTime } from './run-timing';
import styles from './dsh-saas.module.css';

const stepIcons: Record<WorkProcessCategory, ReactNode> = {
  think: <IconThinkOutlineRegular />,
  search: <IconSearchOutlineRegular />,
  market: <IconGlobeOutlineRegular />,
  analyze: <IconDataOutlineRegular />,
  read: <IconBrowseOutlineRegular />,
  find: <IconFolderOpenOutlineRegular />,
  write: <IconEditOutlineRegular />,
  edit: <IconEditOutlineRegular />,
  execute: <IconApiOutlineRegular />,
  browse: <IconBrowseOutlineRegular />,
  skill: <IconSkillOutlineRegular />,
  collaborate: <IconAgentPresetOutlineRegular />,
  question: <IconQuestionOutlineRegular />,
  organize: <IconRefreshOutlineRegular />,
  plan: <IconPlanOutlineRegular />,
  tool: <IconCordisPluginOutlineRegular />,
};
const noop = () => {};

/** DSH's native disclosure/Think chrome over Allrice's public event summary. */
export function WorkProcess({
  items,
  parts,
  timing,
  running,
  streaming,
  failed,
  failureTitle,
  canceled,
  traceStatus,
  onRetry,
  assistantCount,
  assistantAttention,
  children,
  artifacts,
  accessibleFiles,
  onOpenArtifact,
  renderOperation,
  label = '工作过程',
}: {
  items: NativeExperienceItem[];
  parts?: WorkProgressPart[];
  timing?: TaskRuntimeTiming;
  running: boolean;
  streaming: boolean;
  failed: boolean;
  failureTitle?: string;
  canceled: boolean;
  traceStatus?: string;
  onRetry: () => void;
  assistantCount: number;
  assistantAttention: number;
  children?: ReactNode;
  artifacts?: readonly WorkbenchArtifact[];
  accessibleFiles?: readonly { id: string; fileName: string }[];
  onOpenArtifact?: (id: string) => void;
  label?: string;
  renderOperation?: (operationId: string) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const process = summarizeWorkProcess(items);
  const microStatus = running && (!streaming || !!parts);
  const waiting = timing?.phase === 'waiting';
  const title = microStatus
    ? waiting
      ? timing?.resourceWaiting
        ? '等待计算资源…'
        : '等待处理…'
      : process.active === '正在重新连接模型'
        ? '正在重新连接模型…'
        : process.active === '等待模型响应'
          ? '等待模型响应…'
          : process.active === '正在整理上下文'
            ? '正在整理上下文…'
            : process.active
              ? '执行中…'
              : streaming
                ? '回复中…'
                : '思考中…'
    : failed
      ? (failureTitle ?? '未完成')
      : canceled
        ? '已停止'
        : '工作过程';
  const expandable = Boolean(
    process.steps.length ||
    Children.toArray(children).length ||
    traceStatus === 'failed',
  );
  const open = expandable && expanded;
  if (
    !expandable &&
    !failureTitle &&
    !parts?.length &&
    !items.some((item) => item.operationId && renderOperation) &&
    !timing &&
    !microStatus &&
    !assistantCount &&
    traceStatus !== 'loading'
  )
    return null;
  const summary = [
    process.failed ? `${process.failed} 次未成功` : undefined,
    traceStatus === 'failed' ? '过程加载失败' : undefined,
    traceStatus === 'loading' && !process.steps.length
      ? '加载过程…'
      : undefined,
    assistantCount
      ? `${assistantCount} 个助手${assistantAttention ? `，${assistantAttention} 个需关注` : ''}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  if (parts) {
    // DSH keeps a live/failed turn open, then folds its process before the final
    // answer. Native ProcessState already supplies the step/reply boundaries.
    const final =
      !running && parts.at(-1)?.kind === 'reply' ? parts.at(-1) : undefined;
    const history = final ? parts.slice(0, -1) : parts;
    const hasHistory =
      history.length > 0 ||
      Children.toArray(children).length > 0 ||
      traceStatus === 'failed';
    const canFold = !running && !failed && !canceled && hasHistory;
    const showHistory = !canFold || expanded;
    const renderPart = (part: WorkProgressPart, index: number) =>
      part.kind === 'reply' ? (
        <div
          key={part.id === final?.id ? 'final-reply' : part.id}
          className={styles.processReply}
          data-work-reply={part.id}
          hidden={!showHistory && part.id !== final?.id}
        >
          <AssistantMarkdown
            accessibleFiles={accessibleFiles}
            onOpenArtifact={onOpenArtifact}
            text={part.text}
            streaming={streaming && running && index === parts.length - 1}
            artifacts={artifacts}
          />
        </div>
      ) : (
        <div key={part.id} hidden={!showHistory}>
          <WorkProcessGroup
            items={part.items}
            renderOperation={renderOperation}
            running={running && !part.closed}
          />
        </div>
      );
    return (
      <section className={styles.workProcess} aria-label={label}>
        <DisclosureRow
          icon={<IconThinkOutline14 />}
          title={title}
          running={running && !waiting}
          open={canFold && expanded}
          expandable={canFold}
          expandOnRowClick
          keepContentWhenOpen
          onToggle={() => setExpanded((value) => !value)}
          rowClassName={styles.processHeader}
          titleClassName={styles.processTitle}
          collapsedContent={
            <>
              {timing ? (
                <>
                  <span
                    className={`${reasoning.separator} ${styles.processSeparator}`}
                    aria-hidden
                  />
                  <span
                    className={styles.processTiming}
                    aria-label="本轮运行时间"
                  >
                    用时 <RunElapsedTime timing={timing} running={running} />
                  </span>
                </>
              ) : null}
              {summary ? (
                <>
                  <span
                    className={`${reasoning.separator} ${styles.processSeparator}`}
                    aria-hidden
                  />
                  <span
                    className={`${reasoning.summary} ${styles.processSummary}`}
                    title={summary}
                  >
                    {summary}
                  </span>
                </>
              ) : null}
            </>
          }
        />
        <div className={styles.processFlow}>
          {parts.map(renderPart)}
          {traceStatus === 'failed' ? (
            <button
              className={styles.nativeTraceRetry}
              type="button"
              onClick={onRetry}
            >
              过程加载失败，点击重试
            </button>
          ) : null}
          {Children.toArray(children).length ? (
            <div hidden={!showHistory}>{children}</div>
          ) : null}
        </div>
      </section>
    );
  }
  return (
    <section
      className={`${reasoning.root} ${styles.workProcess}`}
      aria-label={label}
    >
      <DisclosureRow
        icon={<IconThinkOutline14 />}
        title={title}
        running={microStatus && !waiting}
        open={open}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        rowClassName={`${reasoning.row} ${styles.processHeader}`}
        leadingClassName={reasoning.leading}
        titleClassName={`${reasoning.title} ${styles.processTitle} ${microStatus ? styles.processStatus : ''}`}
        chevronClassName={reasoning.chevron}
        onToggle={() => setExpanded((value) => !value)}
        collapsedContent={
          <>
            {timing ? (
              <>
                <span
                  className={`${reasoning.separator} ${styles.processSeparator}`}
                  aria-hidden
                />
                <span
                  className={styles.processTiming}
                  aria-label="本轮运行时间"
                >
                  用时 <RunElapsedTime timing={timing} running={running} />
                </span>
              </>
            ) : null}
            {summary ? (
              <>
                <span
                  className={`${reasoning.separator} ${styles.processSeparator}`}
                  aria-hidden
                />
                <span
                  className={`${reasoning.summary} ${styles.processSummary}`}
                  title={summary}
                >
                  {summary}
                </span>
              </>
            ) : null}
          </>
        }
      >
        <div className={styles.processDetails}>
          <WorkProcessSteps items={items} running={running} />
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
      {renderOperation &&
        items
          .filter((item) => item.operationId)
          .map((item) => (
            <div key={item.id}>{renderOperation(item.operationId!)}</div>
          ))}
    </section>
  );
}

/** Native disclosure for concrete step history; only the owning turn announces
 * the current phase. Do not recursively render another turn-status header.
 */
function WorkProcessGroup({
  items,
  running,
  renderOperation,
}: {
  items: NativeExperienceItem[];
  running: boolean;
  renderOperation?: (operationId: string) => ReactNode;
}) {
  // Receipts supplement the native summary; they must not replace its steps.
  // Keep both at this process boundary, before any later assistant reply.
  return (
    <div className={styles.processReceipts}>
      <NativeStepsGroup items={items} running={running} />
      {renderOperation &&
        items
          .filter((item) => item.operationId)
          .map((item) => (
            <div key={item.id}>{renderOperation(item.operationId!)}</div>
          ))}
    </div>
  );
}

function NativeStepsGroup({
  items,
  running,
}: {
  items: NativeExperienceItem[];
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { steps } = summarizeWorkProcess(items);
  if (!steps.length) return null;
  const categories = [...new Set(steps.map((step) => step.label))].join('、');
  return (
    <section aria-label="工作步骤">
      <DisclosureRow
        icon={stepIcons[steps[0]!.category]}
        title={`${categories} · ${steps.length} 项`}
        open={open}
        expandable
        expandOnRowClick
        onToggle={() => setOpen((value) => !value)}
        rowClassName={styles.processHeader}
        titleClassName={styles.processTitle}
      >
        <div className={styles.processDetails}>
          <WorkProcessSteps items={items} running={running} />
        </div>
      </DisclosureRow>
    </section>
  );
}

function WorkProcessSteps({
  items,
  running,
}: {
  items: NativeExperienceItem[];
  running: boolean;
}) {
  const { steps } = summarizeWorkProcess(items);
  if (!steps.length) return null;
  return (
    <ul className={styles.processSteps} aria-label="工作步骤">
      {steps.map((step) => {
        const pending =
          ['started', 'updated'].includes(step.status) &&
          step.category !== 'plan';
        const status =
          step.status === 'failed'
            ? `未成功${step.error ? `：${step.error}` : ''}`
            : step.status === 'info'
              ? '等待处理'
              : pending && !running
                ? '结果未确认'
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
              <small className={styles.processStepStatus}>{status}</small>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
