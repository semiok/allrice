'use client';

import {
  Children,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import {
  WorkProcessReadingState,
  WorkProcessDisclosureScope,
  useProcessDisclosure,
  useQuestionDisclosureOpen,
} from './work-process-reading-state';
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
  nativeSubagentCallKind,
  nativeSubagentDirectoryCall,
} from '../../lib/chatflow/native-subagent-view';
import {
  summarizeWorkProcess,
  workProcessTitle,
  type WorkProcessCategory,
  type WorkProcessStep,
} from '../../lib/chatflow/work-process';
import { IconThinkOutline14 } from './dsh-upstream/ProgressIcons';
import reasoning from './dsh-upstream/ReasoningRow.module.css';
import { RunElapsedTime } from './run-timing';
import { WorkProcessStepView } from './work-process-step';
import {
  UserQuestionReceipt,
  questionReceiptDisclosureId,
  userQuestionReceiptState,
} from './user-question-receipt';
import type { WorkProcessQuestion } from '../../lib/chatflow/work-process-questions';
import styles from './dsh-saas.module.css';
import subagentStyles from './native-subagent-directory.module.css';
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
  questions = [],
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
  onOpenSubagents,
  subagentCount,
  renderOperation,
  transcriptView = 'detailed',
  collapseTiming = 'completion',
  presentation,
  label = '工作过程',
}: {
  items: NativeExperienceItem[];
  questions?: readonly WorkProcessQuestion[];
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
  onOpenSubagents?: (origin: { runId: string; callId: string }) => void;
  subagentCount?: number;
  label?: string;
  renderOperation?: (operationId: string) => ReactNode;
  transcriptView?: UserPreferences['transcriptView'];
  collapseTiming?: UserPreferences['collapseTiming'];
  presentation?: WorkProcessPresentation;
}) {
  const root = useRef<HTMLDivElement>(null);
  const processId = useId();
  const [disclosure, setDisclosure] = useState<WorkProcessDisclosure>();
  const [settledOnMount] = useState(!running);
  const policy = presentationPolicyFor(transcriptView, collapseTiming);
  const currentPresentation =
    presentation ?? workProcessPresentation([], parts, undefined, false);
  const withReadingState = (content: ReactNode) => (
    <WorkProcessReadingState key={currentPresentation.runId} root={root}>
      <div
        ref={root}
        className={styles.processBlock}
        data-process-region={currentPresentation.runId}
      >
        {content}
      </div>
    </WorkProcessReadingState>
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
      setDisclosure((current) =>
        current === disclosure
          ? { ...disclosure, presentation: currentPresentation }
          : current,
      );
  }, [disclosure, currentPresentation]);
  const process = summarizeWorkProcess(items);
  const directoryCall = nativeSubagentDirectoryCall(items);
  const directoryLink =
    onOpenSubagents && directoryCall && currentPresentation.identityKnown ? (
      <button
        type="button"
        className={subagentStyles.processLink}
        onClick={() =>
          onOpenSubagents({
            runId: currentPresentation.runId,
            callId: directoryCall.id.slice(5),
          })
        }
      >
        <IconCordisPluginOutlineRegular />
        查看子智能体
        {Number.isSafeInteger(subagentCount) && subagentCount! >= 0
          ? ` · ${subagentCount} 个智能体`
          : ''}
        <span aria-hidden>›</span>
      </button>
    ) : null;
  const processItems = (entries: NativeExperienceItem[]) =>
    directoryLink
      ? entries.filter(
          (item) =>
            !(
              item.kind === 'tool' &&
              item.toolName === 'list_agents' &&
              item.status === 'completed'
            ),
        )
      : entries;
  const microStatus = running && (!streaming || !!parts);
  const waiting = timing?.phase === 'waiting';
  const acceptingAnswers = running && !failed && !canceled;
  const waitingQuestion =
    acceptingAnswers &&
    questions.some((question) => question.pending && !question.answer);
  const submittedQuestion =
    acceptingAnswers &&
    questions.some(
      (question) =>
        question.pending &&
        question.answer &&
        userQuestionReceiptState(question.answer.status).state !== 'confirmed',
    );
  const title = waitingQuestion
    ? '等待回答'
    : submittedQuestion
      ? '回答已提交'
      : microStatus
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
  const questionKeys = questions.flatMap((question) =>
    question.answer
      ? [
          `step:${questionReceiptDisclosureId(question.request.questionId, question.answer.id)}`,
        ]
      : [],
  );
  const previousQuestions = useRef({
    runId: currentPresentation.runId,
    keys: questionKeys,
  });
  // Exact question/answer ownership can arrive with the final reply identity.
  const migratedKeys =
    previousQuestions.current.runId === currentPresentation.runId
      ? questionKeys.filter(
          (key) => !previousQuestions.current.keys.includes(key),
        )
      : [];
  const readingQuestion = useQuestionDisclosureOpen(questionKeys);
  const revealingQuestion = useQuestionDisclosureOpen(migratedKeys);
  useLayoutEffect(() => {
    // Only a committed ownership move invalidates an older closed choice.
    previousQuestions.current = {
      runId: currentPresentation.runId,
      keys: questionKeys,
    };
    if (revealingQuestion)
      setDisclosure({ presentation: currentPresentation, open: true });
  });
  const revealingQuestions = revealingQuestion ? migratedKeys : [];
  const display = workProcessDisplayState({
    policy,
    presentation: currentPresentation,
    running,
    failed,
    canceled,
    hasHistory: parts ? Boolean(history?.length || expandable) : expandable,
    disclosure:
      (revealingQuestion
        ? { presentation: currentPresentation, open: true }
        : disclosure) ??
      (readingQuestion
        ? { presentation: currentPresentation, open: true }
        : undefined),
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
    const partId = (index: number) => `${processId}-part-${index}`;
    const historyIds = visibleParts.flatMap((part, index) =>
      part.id === final?.id ? [] : [partId(index)],
    );
    const retryId = traceStatus === 'failed' ? `${processId}-retry` : undefined;
    const childrenId = Children.toArray(children).length
      ? `${processId}-children`
      : undefined;
    const directoryId = directoryLink ? `${processId}-subagents` : undefined;
    const ownedIds = [...historyIds, retryId, childrenId, directoryId]
      .filter(Boolean)
      .join(' ');
    const hasVisibleHistory =
      (showHistory &&
        Boolean(historyIds.length || childrenId || directoryId)) ||
      !!retryId;
    const renderPart = (part: WorkProgressPart, index: number) =>
      part.kind === 'reply' ? (
        <div
          key={
            settledOnMount && part.id === final?.id ? 'final-reply' : part.id
          }
          id={partId(index)}
          className={`${styles.processPart} ${styles.processReply}`}
          data-process-member={part.id !== final?.id || undefined}
          data-work-reply={part.id}
          data-process-content={`reply:${part.id}`}
          data-process-append
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
        <div
          key={part.id}
          id={partId(index)}
          className={styles.processPart}
          data-process-member
          hidden={!showHistory}
        >
          <WorkProcessGroup
            items={processItems(part.items)}
            questions={questions}
            revealingQuestions={revealingQuestions}
            renderOperation={renderOperation}
            running={running && !part.closed}
            grouped={display.groupSteps}
            policy={policy}
            answerGeneration={currentPresentation.answerGeneration}
          />
        </div>
      );
    // Keep every part in one keyed parent, including a reply that later becomes
    // history or the final answer. ARIA ownership follows only real history.
    return withReadingState([
      <section
        key="process-header"
        className={`${styles.workProcess} ${hasVisibleHistory ? styles.processExpanded : ''}`}
        aria-label={label}
        aria-owns={ownedIds || undefined}
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
      </section>,
      ...visibleParts.flatMap((part, index) =>
        part.id === final?.id ? [] : [renderPart(part, index)],
      ),
      retryId ? (
        <div
          key="trace-retry"
          id={retryId}
          className={styles.processPart}
          data-process-member
        >
          <button
            className={styles.nativeTraceRetry}
            type="button"
            onClick={onRetry}
          >
            过程加载失败，点击重试
          </button>
        </div>
      ) : null,
      childrenId ? (
        <div
          key="process-children"
          id={childrenId}
          className={styles.processPart}
          data-process-member
          hidden={!showHistory}
        >
          {children}
        </div>
      ) : null,
      directoryId ? (
        <div
          key="subagent-directory"
          id={directoryId}
          className={styles.processPart}
          data-process-member
          hidden={!showHistory}
        >
          {directoryLink}
        </div>
      ) : null,
      final ? renderPart(final, visibleParts.indexOf(final)) : null,
    ]);
  }
  return withReadingState(
    <section
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
            key={currentPresentation.answerGeneration}
            items={processItems(items)}
            questions={questions}
            revealingQuestions={revealingQuestions}
            running={running}
            grouped={display.groupSteps}
            policy={policy}
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
        {directoryLink}
      </div>
      {renderOperation && (
        <div className={styles.processReceipts}>
          {items
            .filter((item) => item.operationId)
            .map((item) => (
              <div
                className={styles.operationReceipt}
                key={item.id}
                data-process-operation={item.operationId}
              >
                <WorkProcessDisclosureScope id={item.operationId!}>
                  {renderOperation(item.operationId!)}
                </WorkProcessDisclosureScope>
              </div>
            ))}
        </div>
      )}
    </section>,
  );
}

/** Native disclosure for concrete step history; only the owning turn announces
 * the current phase. Do not recursively render another turn-status header.
 */
function WorkProcessGroup({
  items,
  questions,
  revealingQuestions,
  running,
  renderOperation,
  grouped,
  policy,
  answerGeneration,
}: {
  items: NativeExperienceItem[];
  questions: readonly WorkProcessQuestion[];
  revealingQuestions: readonly string[];
  running: boolean;
  renderOperation?: (operationId: string) => ReactNode;
  grouped: boolean;
  policy: ChatPresentationPolicy;
  answerGeneration: string;
}) {
  // Receipts supplement the native summary; they must not replace its steps.
  // Keep both at this process boundary, before any later assistant reply.
  return (
    <div className={styles.processReceipts}>
      <NativeStepsGroup
        key={answerGeneration}
        items={items}
        questions={questions}
        revealingQuestions={revealingQuestions}
        running={running}
        grouped={grouped}
        policy={policy}
      />
      {renderOperation &&
        items
          .filter((item) => item.operationId)
          .map((item) => (
            <div
              className={styles.operationReceipt}
              key={item.id}
              data-process-operation={item.operationId}
            >
              <WorkProcessDisclosureScope id={item.operationId!}>
                {renderOperation(item.operationId!)}
              </WorkProcessDisclosureScope>
            </div>
          ))}
    </div>
  );
}

function NativeStepsGroup({
  items,
  questions,
  revealingQuestions,
  running,
  grouped,
  policy,
}: {
  items: NativeExperienceItem[];
  questions: readonly WorkProcessQuestion[];
  revealingQuestions: readonly string[];
  running: boolean;
  grouped: boolean;
  policy: ChatPresentationPolicy;
}) {
  const [manual, setOpen] = useProcessDisclosure<boolean | undefined>(
    items.map((item) => `group:${item.id}`),
    undefined,
  );
  const questionKeys = questions.flatMap((question) =>
    question.answer &&
    items.some((item) => item.id === `tool:${question.callId}`)
      ? [
          `step:${questionReceiptDisclosureId(question.request.questionId, question.answer.id)}`,
        ]
      : [],
  );
  const readingQuestion = useQuestionDisclosureOpen(questionKeys);
  const revealingQuestion = useQuestionDisclosureOpen(
    questionKeys.filter((key) => revealingQuestions.includes(key)),
  );
  const open = revealingQuestion || (manual ?? readingQuestion);
  useLayoutEffect(() => {
    if (revealingQuestion) setOpen(true);
  });
  const { steps } = summarizeWorkProcess(items);
  if (!steps.length || onlyLiveThinking(steps, running)) return null;
  // The approved default process already has its turn disclosure. Show its
  // concrete steps directly; saved compact/standard grouping stays native.
  if (policy.mode === 'detailed')
    return (
      <section aria-label="工作步骤" className={styles.processDetails}>
        <WorkProcessSteps
          items={items}
          questions={questions}
          running={running}
          policy={policy}
        />
      </section>
    );
  if (!grouped || steps.every((step) => step.category === 'question'))
    return (
      <WorkProcessSteps
        items={items}
        questions={questions}
        running={running}
        policy={policy}
      />
    );
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
    <section aria-label="工作步骤">
      <DisclosureRow
        icon={stepIcons[steps[0]!.category]}
        title={workProcessTitle(items, running)}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => setOpen(!open)}
        rowClassName={styles.processHeader}
        titleClassName={styles.processTitle}
        collapsedContent={
          <>
            {items.map((item) => (
              <span key={item.id} data-process-control={`group:${item.id}`} />
            ))}
            {!open && preview ? (
              <>
                <span className={reasoning.separator} aria-hidden />
                <span className={styles.processStepDescription}>{preview}</span>
              </>
            ) : null}
          </>
        }
      >
        <div className={styles.processDetails}>
          <WorkProcessSteps
            items={items}
            questions={questions}
            running={running}
            policy={policy}
          />
        </div>
      </DisclosureRow>
    </section>
  );
}

function WorkProcessSteps({
  items,
  questions,
  running,
  policy,
}: {
  items: NativeExperienceItem[];
  questions: readonly WorkProcessQuestion[];
  running: boolean;
  policy: ChatPresentationPolicy;
}) {
  const { steps } = summarizeWorkProcess(items);
  if (!steps.length) return null;
  return (
    <ul className={styles.processSteps} aria-label="工作步骤">
      {steps.map((step) => {
        const subagentCallKind = nativeSubagentCallKind(
          items.find((item) => item.id === step.id && item.kind === 'tool')
            ?.toolName,
        );
        const question = questions.find(
          (question) => step.id === `tool:${question.callId}`,
        );
        const active = ['started', 'updated'].includes(step.status);
        const pending = active && step.category !== 'plan';
        const status =
          step.status === 'failed'
            ? '未成功'
            : running && question?.pending && !question.answer
              ? '等待回答'
              : question?.answered
                ? '已回答'
                : step.status === 'info'
                  ? '结果未确认'
                  : step.status === 'completed'
                    ? '已完成'
                    : active && !running
                      ? '结果未确认'
                      : active
                        ? '运行中'
                        : '结果未确认';
        return (
          <li
            key={step.id}
            data-category={step.category}
            data-failed={step.status === 'failed' || undefined}
          >
            {question?.answer ? (
              <UserQuestionReceipt
                messageId={question.answer.id}
                answer={question.answer.answer}
                text={question.answer.text}
                createdAt={question.answer.createdAt}
                status={question.answer.status}
                questions={question.request.questions}
              />
            ) : (
              <WorkProcessStepView
                id={step.id}
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
                title={
                  question
                    ? `提问 · ${question.request.questions[0]?.question ?? step.title}`
                    : subagentCallKind === 'create'
                      ? `创建子智能体${step.input ? ` · ${step.input}` : ''}`
                      : subagentCallKind === 'directory'
                        ? '查看子智能体'
                        : step.title
                }
                status={status}
                elapsedMs={step.elapsedMs}
                running={pending && running}
                failed={step.status === 'failed'}
                initialOpen={
                  policy.mode === 'verbose' || step.status === 'failed'
                }
                details={
                  question
                    ? question.request.questions.map((item) => ({
                        label: '问题',
                        value: item.question,
                      }))
                    : subagentCallKind === 'create' &&
                        step.status === 'completed'
                      ? []
                      : [
                          ...(step.input
                            ? [{ label: '输入', value: step.input }]
                            : []),
                          ...(step.result
                            ? [
                                {
                                  label:
                                    step.status === 'failed' ? '原因' : '结果',
                                  value: step.result,
                                },
                              ]
                            : []),
                        ]
                }
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
