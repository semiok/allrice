'use client';

import {
  memo,
  useState,
  useEffect,
  type RefObject,
  type CSSProperties,
} from 'react';
import {
  nativeExecutionFailureText,
  mcpFailureCopy,
  type WorkbenchArtifact,
  type InteractionStatus,
  type UserPreferences,
} from '@allrice/contracts';

import {
  isReplyStreaming,
  projectWorkProgress,
  type WorkProgressPart,
} from '../../lib/chatflow/work-progress';
import { summarizeWorkProcess } from '../../lib/chatflow/work-process';

import { AssistantMarkdown, ArtifactLinkResolver } from './assistant-markdown';
import type { MessageImageSource } from './message-image-cache';
import type {
  Message,
  RunTrace,
  RunView,
  WorkspaceFile,
} from './chatflow-types';
import { BrowserWorkspacePanel } from './browser-workspace-panel';
import { hasBrowserWorkspaceEvents } from '../../lib/chatflow/managed-browser-task-presenter';
import { assistantDelta } from './chatflow-utils';
import assistantUi from './dsh-upstream/AssistantMarkdown.module.css';
import chatUi from './dsh-upstream/ChatView.module.css';
import styles from './dsh-saas.module.css';
import {
  hasManagedBrowserEvents,
  ManagedBrowserTaskPanel,
} from './managed-browser-task-panel';
import { LocalCommandPanel } from './local-command-panel';
import { LocalMcpPanel } from './local-mcp-panel';
import { hasLocalMcpEvents } from '../../lib/chatflow/local-mcp-task-presenter';
import { CloudOperationPanel } from './cloud-operation-panel';
import { ArtifactSummaryCards } from './artifact-workbench';
import { SteeredWorkProcess } from './steered-work-process';
import { type ReferenceDraft } from './reference-chips';
import { TranscriptUserMessage } from './transcript-user-message';
import { AutomationRunTaskCards } from './automation-run-task-cards';
import { AssistantMessageActions } from './message-feedback';
import { isMessageRunActive } from './run-view';
import { HistoryRefreshNotice } from './history-refresh-notice';
import { workProcessPresentation } from '../../lib/chatflow/work-process-presentation';
import {
  presentReplyFailure,
  replyBudgetKept,
} from '../../lib/chatflow/reply-failure-copy';

interface ChatTranscriptProps {
  onOpenReference?: (reference: ReferenceDraft) => void;
  messageImages?: MessageImageSource;
  streamingOutput?: boolean;
  fontSize?: UserPreferences['fontSize'];
  transcriptView?: UserPreferences['transcriptView'];
  collapseTiming?: UserPreferences['collapseTiming'];
  atBottom: boolean;
  employeeName?: string;
  localCommandsEnabled?: boolean;
  localMcpEnabled?: boolean;
  runTimings?: InteractionStatus['runTimings'];
  messages: Message[];
  recoverableRunView?: RunView;
  /** The newest read of this conversation failed; offer to read it again. */
  historyStale?: boolean;
  onRefreshHistory?: () => Promise<unknown>;
  runTraces: Record<string, RunTrace>;
  runViews: Record<string, RunView>;
  tenantHeaders: Record<string, string>;
  transcriptColumn: RefObject<HTMLDivElement | null>;
  workspaceId: string;
  onLoadRunTrace: (runId: string) => void | Promise<void>;
  onRecoverRun: (runId: string) => void | Promise<void>;
  onScrollToBottom: () => void;
  artifacts?: WorkbenchArtifact[];
  onOpenArtifact?: (id: string) => void;
  onOpenAutomation?: (id: string) => void;
  onResolveArtifactLink?: (href: string, runId: string) => Promise<boolean>;
}

export const ChatTranscript = memo(function ChatTranscript({
  onOpenReference,
  messageImages,
  streamingOutput = false,
  fontSize = 14,
  transcriptView = 'detailed',
  collapseTiming = 'completion',
  atBottom,
  employeeName = 'AI 员工',
  localCommandsEnabled = false,
  localMcpEnabled = false,
  runTimings = [],
  messages,
  recoverableRunView,
  historyStale = false,
  onRefreshHistory,
  runTraces,
  runViews,
  tenantHeaders,
  transcriptColumn,
  workspaceId,
  onLoadRunTrace,
  onRecoverRun,
  onScrollToBottom,
  artifacts = [],
  onOpenArtifact,
  onOpenAutomation,
  onResolveArtifactLink,
}: ChatTranscriptProps) {
  const [downloadFiles, setDownloadFiles] = useState<{
    workspaceId: string;
    files: WorkspaceFile[];
  } | null>(null);
  // Existing uploads need the same origin adaptation as formal Artifacts.
  // Resolve their authenticated metadata only when settled replies reference
  // files; no polling, extra model calls or changes to DSH's streaming parser.
  const downloadRequest = [
    ...new Set(
      messages
        .filter(
          (m) =>
            m.role === 'assistant' &&
            !isMessageRunActive(m, runViews[m.runId ?? '']),
        )
        .flatMap(
          (m) =>
            m.content.text
              .replace(/\\+\//g, '/')
              .match(/\/api\/v1\/files\/[a-f0-9-]{36}/g) ?? [],
        ),
    ),
  ]
    .sort()
    .join(',');
  useEffect(() => {
    if (!downloadRequest) return;
    const controller = new AbortController();
    void fetch(`/api/v1/files?workspaceId=${encodeURIComponent(workspaceId)}`, {
      cache: 'no-store',
      headers: tenantHeaders,
      signal: controller.signal,
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { files: WorkspaceFile[] })
          : null,
      )
      .then((result) => {
        if (result && !controller.signal.aborted)
          setDownloadFiles({ workspaceId, files: result.files });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [downloadRequest, workspaceId, tenantHeaders]);
  const accessibleFiles =
    downloadFiles?.workspaceId === workspaceId ? downloadFiles.files : [];
  const [browserRevisions, setBrowserRevisions] = useState<
    Record<string, number>
  >({});
  const timingByRun = new Map(
    runTimings.map((entry) => [entry.runId, entry.timing]),
  );
  const assistantRuns = new Set(
    messages.filter((m) => m.role === 'assistant').map((m) => m.runId),
  );
  const adopted = messages.filter(
    (m) =>
      m.role === 'user' &&
      m.steering?.status === 'adopted' &&
      m.steering.runId &&
      assistantRuns.has(m.steering.runId),
  );
  const embedded = new Set(adopted.map((m) => m.id));
  // Queued drafts and in-turn answers/steering are not a new exchange.
  const followedByInput = new Set<string>();
  let laterInput = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'assistant' && laterInput)
      followedByInput.add(message.id);
    if (
      message.role === 'user' &&
      !message.steering &&
      message.content.interaction?.type !== 'user_question_answer' &&
      !message.id.startsWith('optimistic-')
    )
      laterInput = true;
  }
  return (
    <div
      className={chatUi.root}
      data-conversation-typography
      style={{ '--dsh-content-font-size': `${fontSize}px` } as CSSProperties}
    >
      <div className={chatUi.scroll} data-chat-scroll>
        <div className={chatUi.column} ref={transcriptColumn}>
          {messages
            .filter((message) => !embedded.has(message.id))
            .filter(
              (message) =>
                message.role !== 'assistant' ||
                message.status !== 'completed' ||
                message.content.text.length > 0 ||
                adopted.some(
                  (input) => input.steering?.runId === message.runId,
                ),
            )
            .map((message) => {
              const messageRun = message.runId
                ? (runViews[message.runId] ?? null)
                : null;
              const trace = message.runId
                ? runTraces[message.runId]
                : undefined;
              const timing = message.runId
                ? timingByRun.get(message.runId)
                : undefined;
              const traceEvents = messageRun?.events ?? trace?.events ?? [];
              const messageIsRunning = isMessageRunActive(message, messageRun);
              const streamedText = messageRun
                ? assistantDelta(messageRun.events)
                : '';
              const linkedArtifacts = artifacts.filter(
                (a) => a.provenance.runId === message.runId,
              );
              // One reading of a failure, shared by the reply body and the note under it.
              const failure =
                message.status === 'failed'
                  ? presentReplyFailure({
                      code: message.errorCode,
                      text: message.content.text,
                      nativeText: nativeExecutionFailureText(message.errorCode),
                      budgetWarning: !!message.content.budgetWarning,
                    })
                  : null;
              const fallbackText =
                message.status === 'pending'
                  ? ''
                  : (failure?.body ?? message.content.text);
              const progress = projectWorkProgress(
                traceEvents,
                fallbackText,
                messageIsRunning,
                streamingOutput,
              );
              const responseText = progress.finalText;
              const applicationFailure =
                message.status === 'failed' && message.applicationFailure
                  ? mcpFailureCopy[message.applicationFailure]
                  : null;

              return (
                <div
                  className={chatUi.flowItem}
                  key={message.id}
                  id={`message-${message.id}`}
                >
                  {message.role === 'user' ? (
                    <TranscriptUserMessage
                      message={message}
                      onOpenAutomation={onOpenAutomation}
                      messageImages={messageImages}
                      onOpenReference={onOpenReference}
                    />
                  ) : (
                    <ArtifactLinkResolver.Provider
                      value={
                        onResolveArtifactLink && message.runId
                          ? (href) =>
                              onResolveArtifactLink(href, message.runId!)
                          : undefined
                      }
                    >
                      <div
                        className={assistantUi.root}
                        data-actions-reveal="hover"
                        data-working={
                          (messageIsRunning &&
                            !adopted.some(
                              (m) => m.steering?.runId === message.runId,
                            ) &&
                            (!timing || timing.phase === 'active')) ||
                          undefined
                        }
                      >
                        <div className={styles.assistantIdentity}>
                          <i aria-hidden="true" />
                          <span>{employeeName}</span>
                        </div>
                        <CloudOperationPanel
                          runId={message.runId ?? ''}
                          workspaceId={workspaceId}
                          tenantHeaders={tenantHeaders}
                          runActive={messageIsRunning}
                        >
                          {({ operations, renderOperation, feedback }) => {
                            const timeline = projectWorkProgress(
                              traceEvents,
                              fallbackText,
                              messageIsRunning,
                              streamingOutput,
                              operations,
                            );
                            // History text arrives before the native event trace.
                            // Keep a settled streaming reply in the same process
                            // frame while its steps and timing are being restored.
                            const processParts: WorkProgressPart[] | undefined =
                              timeline.parts ??
                              (streamingOutput &&
                              !messageIsRunning &&
                              message.status === 'completed' &&
                              message.runId &&
                              responseText
                                ? [
                                    // Legacy traces restore steps without named
                                    // reply boundaries. The parts renderer must
                                    // keep those rows beside the saved answer.
                                    ...(summarizeWorkProcess(timeline.items)
                                      .steps.length
                                      ? [
                                          {
                                            kind: 'steps' as const,
                                            id: 'history-steps',
                                            sequence:
                                              timeline.items[0]?.sequence ?? 0,
                                            items: timeline.items,
                                            closed: true,
                                          },
                                        ]
                                      : []),
                                    {
                                      kind: 'reply' as const,
                                      id: 'history-reply',
                                      sequence: 0,
                                      text: responseText,
                                    },
                                  ]
                                : undefined);
                            return (
                              <>
                                {feedback}
                                <SteeredWorkProcess
                                  transcriptView={transcriptView}
                                  collapseTiming={collapseTiming}
                                  presentation={workProcessPresentation(
                                    traceEvents,
                                    processParts,
                                    message.runId ?? message.id,
                                    followedByInput.has(message.id),
                                    adopted.some(
                                      (input) =>
                                        input.steering?.runId === message.runId,
                                    ),
                                  )}
                                  events={traceEvents}
                                  messages={adopted.filter(
                                    (m) => m.steering?.runId === message.runId,
                                  )}
                                  messageImages={messageImages}
                                  employeeName={employeeName}
                                  accessibleFiles={accessibleFiles}
                                  items={timeline.items}
                                  parts={processParts}
                                  renderOperation={renderOperation}
                                  artifacts={linkedArtifacts}
                                  onOpenArtifact={onOpenArtifact}
                                  timing={timing}
                                  running={messageIsRunning}
                                  streaming={
                                    streamingOutput &&
                                    messageIsRunning &&
                                    isReplyStreaming(traceEvents)
                                  }
                                  failed={
                                    message.status === 'failed' ||
                                    messageRun?.status === 'failed'
                                  }
                                  failureTitle={
                                    message.applicationFailure ===
                                    'result_unknown'
                                      ? '结果待确认'
                                      : applicationFailure?.title
                                  }
                                  canceled={messageRun?.status === 'canceled'}
                                  traceStatus={trace?.status}
                                  onRetry={() => {
                                    if (message.runId)
                                      void onLoadRunTrace(message.runId);
                                  }}
                                />
                                {!!message.content.citations?.some(
                                  (c) => c.type === 'knowledge' && c.reference,
                                ) && (
                                  <div
                                    className={styles.referenceSources}
                                    aria-label="参考资料来源"
                                  >
                                    <span>本次检索资料</span>
                                    {message.content.citations.map(
                                      (c, index) =>
                                        c.type === 'knowledge' &&
                                        c.reference ? (
                                          <button
                                            type="button"
                                            key={c.id}
                                            onClick={() =>
                                              onOpenReference?.(c.reference!)
                                            }
                                          >
                                            [
                                            {c.referenceLabel ??
                                              `K${index + 1}`}
                                            ] {c.label}
                                          </button>
                                        ) : null,
                                    )}
                                  </div>
                                )}
                                {applicationFailure && (
                                  <p
                                    className={styles.failedMessage}
                                    role="status"
                                  >
                                    本轮已结束。{applicationFailure.detail}
                                  </p>
                                )}
                                {message.runId &&
                                hasManagedBrowserEvents(traceEvents) ? (
                                  <ManagedBrowserTaskPanel
                                    runActive={messageIsRunning}
                                    runId={message.runId}
                                    tenantHeaders={tenantHeaders}
                                    workspaceId={workspaceId}
                                  />
                                ) : null}
                                {message.runId &&
                                  hasBrowserWorkspaceEvents(traceEvents) && (
                                    <BrowserWorkspacePanel
                                      refreshKey={
                                        browserRevisions[message.runId] ?? 0
                                      }
                                      runId={message.runId}
                                      workspaceId={workspaceId}
                                      tenantHeaders={tenantHeaders}
                                      runActive={messageIsRunning}
                                      employeeName={employeeName}
                                    />
                                  )}

                                {localCommandsEnabled && message.runId && (
                                  <LocalCommandPanel
                                    onServiceChanged={() =>
                                      setBrowserRevisions((previous) => ({
                                        ...previous,
                                        [message.runId!]:
                                          (previous[message.runId!] ?? 0) + 1,
                                      }))
                                    }
                                    runId={message.runId}
                                    workspaceId={workspaceId}
                                    tenantHeaders={tenantHeaders}
                                    runActive={messageIsRunning}
                                  />
                                )}
                                {localMcpEnabled &&
                                  message.runId &&
                                  hasLocalMcpEvents(traceEvents) && (
                                    <LocalMcpPanel
                                      runId={message.runId}
                                      workspaceId={workspaceId}
                                      tenantHeaders={tenantHeaders}
                                      runActive={messageIsRunning}
                                    />
                                  )}
                                {responseText && !processParts ? (
                                  <div
                                    className={`${assistantUi.body} ${styles.assistantCopy}`}
                                    data-streaming={
                                      (messageIsRunning && !!streamedText) ||
                                      undefined
                                    }
                                  >
                                    <AssistantMarkdown
                                      accessibleFiles={accessibleFiles}
                                      text={responseText}
                                      streaming={
                                        streamingOutput && messageIsRunning
                                      }
                                      artifacts={linkedArtifacts}
                                      onOpenArtifact={onOpenArtifact}
                                    />
                                  </div>
                                ) : null}
                                {message.content.budgetWarning &&
                                message.status === 'failed' ? (
                                  <small role="status">{replyBudgetKept}</small>
                                ) : failure?.notice &&
                                  !applicationFailure &&
                                  responseText !== failure.notice ? (
                                  <small className={styles.failedMessage}>
                                    {failure.notice}
                                  </small>
                                ) : null}
                                {onOpenArtifact && message.runId ? (
                                  <ArtifactSummaryCards
                                    artifacts={linkedArtifacts}
                                    onOpen={onOpenArtifact}
                                  />
                                ) : null}
                              </>
                            );
                          }}
                        </CloudOperationPanel>
                        {onOpenAutomation &&
                        message.automationTaskIds?.length ? (
                          <AutomationRunTaskCards
                            taskIds={message.automationTaskIds}
                            workspaceId={workspaceId}
                            headers={tenantHeaders}
                            onOpen={onOpenAutomation}
                          />
                        ) : null}
                        {!messageIsRunning && responseText && message.runId ? (
                          <AssistantMessageActions
                            messageId={message.id}
                            text={responseText}
                            createdAt={message.createdAt}
                            workMethods={message.workMethods}
                          />
                        ) : null}
                      </div>
                    </ArtifactLinkResolver.Provider>
                  )}
                </div>
              );
            })}

          {recoverableRunView ? (
            <div className={styles.connectionRetry} role="status">
              <span>实时连接暂时中断</span>
              <button
                onClick={() => void onRecoverRun(recoverableRunView.runId)}
                type="button"
              >
                重试
              </button>
            </div>
          ) : historyStale && onRefreshHistory ? (
            <HistoryRefreshNotice onRefresh={onRefreshHistory} />
          ) : null}
        </div>
        {!atBottom ? (
          <div className={chatUi.toBottomSlot}>
            <button
              aria-label="回到底部"
              className={chatUi.toBottom}
              onClick={onScrollToBottom}
              title="回到底部"
              type="button"
            >
              ↓
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});
