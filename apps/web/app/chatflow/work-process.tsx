'use client';

import { Children, useEffect, useState, type ReactNode } from 'react';
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
  IconPlanOutlineRegular,
  IconQuestionOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconSkillOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconDataOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  TaskRuntimeTiming,
  WorkbenchArtifact,
  UserPreferences,
} from '@allrice/contracts';
import type { NativeExperienceItem } from '../../lib/chatflow/native-experience';
import {
  summarizeWorkProcess,
  workProcessStepNeedsAttention,
  type WorkProcessCategory,
  type WorkProcessStep,
} from '../../lib/chatflow/work-process';
import { IconThinkOutline14 } from './dsh-upstream/ProgressIcons';
import reasoning from './dsh-upstream/ReasoningRow.module.css';
import { RunElapsedTime } from './run-timing';
import styles from './dsh-saas.module.css';
import {
  WorkProcessDisclosureProvider,
  WorkProcessDisclosureScope,
  useWorkProcessDisclosures,
  useProcessDisclosure,
  useWorkGroupDisclosure,
} from './work-process-disclosure';
import { presentationPolicyFor } from './dsh-upstream/presentation/presentation-policy';
import type { ChatPresentationPolicy } from '@deepseek-ai/dsh-client-ui-chat/client';
import {
  workProcessDisplayState,
  workProcessPresentation,
  type WorkProcessDisclosure,
  type WorkProcessPresentation,
} from '../../lib/chatflow/work-process-presentation';

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
  question: <IconQuestionOutlineRegular />,
  organize: <IconRefreshOutlineRegular />,
  plan: <IconPlanOutlineRegular />,
  tool: <IconCordisPluginOutlineRegular />,
};
type RenderOperation = (operationId: string, embedded?: boolean) => ReactNode;

/** A live reasoning lifecycle adds no detail beyond the current phase header. */
function onlyLiveThinking(steps: WorkProcessStep[], running: boolean) {
  return (
    running &&
    steps.length > 0 &&
    steps.every(
      (step) =>
        step.category === 'think' &&
        ['started', 'updated'].includes(step.status),
    )
  );
}

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
  children,
  artifacts,
  accessibleFiles,
  onOpenArtifact,
  renderOperation,
  transcriptView = 'detailed',
  collapseTiming = 'completion',
  presentation,
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
  children?: ReactNode;
  artifacts?: readonly WorkbenchArtifact[];
  accessibleFiles?: readonly { id: string; fileName: string }[];
  onOpenArtifact?: (id: string) => void;
  label?: string;
  renderOperation?: RenderOperation;
  transcriptView?: UserPreferences['transcriptView'];
  collapseTiming?: UserPreferences['collapseTiming'];
  presentation?: WorkProcessPresentation;
}) {
  const [disclosure, setDisclosure] = useState<WorkProcessDisclosure>();
  const [settledOnMount] = useState(!running);
  const policy = presentationPolicyFor(transcriptView, collapseTiming);
  const currentPresentation =
    presentation ?? workProcessPresentation([], parts, undefined, false);
  const disclosures = useWorkProcessDisclosures(currentPresentation.runId);
  const withDisclosures = (content: ReactNode) => (
    <WorkProcessDisclosureProvider value={disclosures.value}>
      {content}
    </WorkProcessDisclosureProvider>
  );
  useEffect(() => {
    // A history answer can be expanded before its trace arrives. Bind that
    // choice once to the restored identity, so a later retry still resets it.
    if (
      disclosure &&
      !disclosure.presentation.identityKnown &&
      currentPresentation.identityKnown &&
      disclosure.presentation.runId === currentPresentation.runId
    )
      setDisclosure({ ...disclosure, presentation: currentPresentation });
  }, [disclosure, currentPresentation]);
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
            ? '正在整理对话…'
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
    (process.steps.length && !onlyLiveThinking(process.steps, running)) ||
    Children.toArray(children).length ||
    traceStatus === 'failed',
  );
  const final = !running
    ? parts?.findLast(
        (part) =>
          part.kind === 'reply' &&
          (part.finalAnswer || part.id === currentPresentation.finalReplyId),
      )
    : undefined;
  const history = parts?.filter((part) => part.id !== final?.id);
  const display = workProcessDisplayState({
    policy,
    presentation: currentPresentation,
    running,
    failed,
    canceled,
    hasHistory: parts ? Boolean(history?.length || expandable) : expandable,
    disclosure,
    needsAttention: process.steps.some(workProcessStepNeedsAttention),
  });
  const toggle = () =>
    setDisclosure({ presentation: currentPresentation, open: !display.open });
  if (
    !expandable &&
    !failureTitle &&
    !parts?.length &&
    !items.some((item) => item.operationId && renderOperation) &&
    !timing &&
    !microStatus &&
    traceStatus !== 'loading'
  )
    return null;
  const summary = [
    process.failed ? `${process.failed} 次未成功` : undefined,
    traceStatus === 'failed' ? '过程加载失败' : undefined,
    traceStatus === 'loading' && !process.steps.length
      ? '加载过程…'
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  if (parts) {
    // The native policy owns folding; the accepted final answer stays visible.
    const showHistory = display.open;
    const visibleParts = parts.filter(
      (part) =>
        part.kind === 'reply' ||
        !onlyLiveThinking(
          summarizeWorkProcess(part.items).steps,
          running && !part.closed,
        ) ||
        part.items.some((item) => item.operationId && renderOperation),
    );
    const renderPart = (part: WorkProgressPart) =>
      part.kind === 'reply' ? (
        <div
          key={
            settledOnMount && part.id === final?.id ? 'final-reply' : part.id
          }
          className={styles.processReply}
          data-work-reply={part.id}
          hidden={!showHistory && part.id !== final?.id}
        >
          <AssistantMarkdown
            accessibleFiles={accessibleFiles}
            onOpenArtifact={onOpenArtifact}
            text={part.text}
            streaming={streaming && running && part === parts.at(-1)}
            artifacts={artifacts}
          />
        </div>
      ) : (
        <div key={part.id} hidden={!showHistory}>
          <NativeStepsGroup
            key={currentPresentation.runId}
            items={part.items}
            renderOperation={renderOperation}
            running={running && !part.closed}
            grouped={display.groupSteps}
            policy={policy}
          />
        </div>
      );
    return withDisclosures(
      <section
        {...disclosures.focusProps}
        className={styles.workProcess}
        aria-label={label}
        data-transcript-view={policy.mode}
        data-process-open={display.open}
      >
        <DisclosureRow
          icon={<IconThinkOutline14 />}
          title={title}
          headerAccessory={
            timing ? (
              <span className={styles.processTiming} aria-label="本轮运行时间">
                用时 <RunElapsedTime timing={timing} running={running} />
              </span>
            ) : undefined
          }
          running={running && !waiting}
          open={display.canFold && display.open}
          expandable={display.canFold}
          expandOnRowClick
          keepContentWhenOpen
          onToggle={toggle}
          rowClassName={styles.processHeader}
          titleClassName={styles.processTitle}
          collapsedContent={
            <>
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
        {visibleParts.length ||
        traceStatus === 'failed' ||
        Children.toArray(children).length ? (
          <div className={styles.processFlow}>
            {visibleParts.map(renderPart)}
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
        ) : null}
      </section>,
    );
  }
  return withDisclosures(
    <section
      {...disclosures.focusProps}
      className={`${reasoning.root} ${styles.workProcess}`}
      aria-label={label}
      data-transcript-view={policy.mode}
      data-process-open={display.open}
    >
      <DisclosureRow
        icon={<IconThinkOutline14 />}
        title={title}
        headerAccessory={
          timing ? (
            <span className={styles.processTiming} aria-label="本轮运行时间">
              用时 <RunElapsedTime timing={timing} running={running} />
            </span>
          ) : undefined
        }
        running={microStatus && !waiting}
        open={display.canFold && display.open}
        expandable={display.canFold}
        expandOnRowClick
        keepContentWhenOpen
        rowClassName={`${reasoning.row} ${styles.processHeader}`}
        leadingClassName={reasoning.leading}
        titleClassName={`${reasoning.title} ${styles.processTitle} ${microStatus ? styles.processStatus : ''}`}
        chevronClassName={reasoning.chevron}
        onToggle={toggle}
        collapsedContent={
          <>
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
      <div hidden={!display.open || !expandable}>
        <div className={styles.processDetails}>
          <NativeStepsGroup
            key={currentPresentation.runId}
            items={items}
            running={running}
            grouped={display.groupSteps}
            policy={policy}
            renderOperation={renderOperation}
          />
          {traceStatus === 'failed' ? (
            <button
              className={styles.nativeTraceRetry}
              onClick={onRetry}
              type="button"
            >
              过程加载失败，点击重试
            </button>
          ) : null}
        </div>
        {children}
      </div>
    </section>,
  );
}

function NativeStepsGroup({
  items,
  running,
  grouped,
  policy,
  renderOperation,
}: {
  items: NativeExperienceItem[];
  running: boolean;
  grouped: boolean;
  policy: ChatPresentationPolicy;
  renderOperation?: RenderOperation;
}) {
  const { steps } = summarizeWorkProcess(items);
  const [open, setOpen] = useWorkGroupDisclosure(
    steps.map((step) => step.operationId ?? step.id),
  );
  if (!steps.length || onlyLiveThinking(steps, running)) return null;
  const showGroup = grouped && !steps.some(workProcessStepNeedsAttention);
  const categories = [...new Set(steps.map((step) => step.label))].join('、');
  const live = [...steps]
    .reverse()
    .find((step) => ['started', 'updated'].includes(step.status));
  const preview =
    running && policy.liveProcessDetail
      ? live?.description
      : policy.settledReasoningPreview &&
          steps.every((step) => step.category === 'think')
        ? steps[0]?.description
        : undefined;
  return (
    <section aria-label="工作步骤" data-work-group-open={!showGroup || open}>
      {showGroup && (
        <DisclosureRow
          icon={stepIcons[steps[0]!.category]}
          title={`${categories} · ${steps.length} 项`}
          open={open}
          expandable
          expandOnRowClick
          onToggle={() => setOpen(!open)}
          rowClassName={styles.processHeader}
          titleClassName={styles.processTitle}
          collapsedContent={
            preview ? (
              <>
                <span className={reasoning.separator} aria-hidden />
                <span className={styles.processStepDescription}>{preview}</span>
              </>
            ) : undefined
          }
        />
      )}
      <div
        className={showGroup ? styles.processDetails : undefined}
        hidden={showGroup && !open}
      >
        <WorkProcessSteps
          steps={steps}
          running={running}
          renderOperation={renderOperation}
        />
      </div>
    </section>
  );
}

function WorkProcessSteps({
  steps,
  running,
  renderOperation,
}: {
  steps: WorkProcessStep[];
  running: boolean;
  renderOperation?: RenderOperation;
}) {
  if (!steps.length) return null;
  return (
    <ul className={styles.processSteps} aria-label="工作步骤">
      {steps.map((step) => (
        <WorkProcessDisclosureScope
          key={step.operationId ?? step.id}
          id={step.operationId ?? step.id}
        >
          <WorkProcessStepRow
            step={step}
            running={running}
            renderOperation={renderOperation}
          />
        </WorkProcessDisclosureScope>
      ))}
    </ul>
  );
}

/** The receipt is the content of its call row, never a second transcript list. */
function WorkProcessStepRow({
  step,
  running,
  renderOperation,
}: {
  step: WorkProcessStep;
  running: boolean;
  renderOperation?: RenderOperation;
}) {
  const [disclosure, setDisclosure] = useProcessDisclosure<boolean | undefined>(
    'call',
    undefined,
  );
  const open = disclosure ?? workProcessStepNeedsAttention(step);
  const hasReceipt = Boolean(step.operationId && renderOperation);
  const pending =
    ['started', 'updated'].includes(step.status) && step.category !== 'plan';
  const status =
    step.status === 'failed'
      ? `未成功${step.error ? `：${step.error}` : ''}`
      : step.operationStatus
        ? undefined
        : step.status === 'info'
          ? '等待处理'
          : pending && !running
            ? '结果未确认'
            : undefined;
  return (
    <li
      id={step.operationId ? `operation-${step.operationId}` : undefined}
      data-work-call={step.id}
      data-category={step.category}
      data-failed={step.status === 'failed' || undefined}
    >
      <DisclosureRow
        icon={
          <span
            className={pending && running ? styles.processPulse : undefined}
            aria-hidden
          >
            {stepIcons[step.category]}
          </span>
        }
        title={step.label}
        open={hasReceipt && open}
        expandable={hasReceipt}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setDisclosure(!open)}
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
      >
        {hasReceipt ? (
          <div className={styles.operationReceipt}>
            {renderOperation!(step.operationId!, true)}
          </div>
        ) : null}
      </DisclosureRow>
      {status ? (
        <small className={styles.processStepStatus}>{status}</small>
      ) : null}
    </li>
  );
}
