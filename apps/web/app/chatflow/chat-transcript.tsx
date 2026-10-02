'use client';

import { useState, type RefObject } from 'react';
import {
  modelGovernanceFailureText,
  nativeExecutionFailureText,
  nativeExecutionDiagnosticFailureText,
  mcpFailureCopy,
  type WorkbenchArtifact,
  type InteractionStatus,
} from '@allrice/contracts';
import { SessionReferenceChips } from './session-reference-picker';
import type { AssistantTreeView } from '@allrice/database';

import {
  isReplyStreaming,
  projectWorkProgress,
} from '../../lib/chatflow/work-progress';

import { AssistantMarkdown } from './assistant-markdown';
import type { MessageImageSource } from './message-image-cache';
import { MessageImageGallery } from './attachment-components';
import type { Message, RunTrace, RunView } from './chatflow-types';
import { BrowserWorkspacePanel } from './browser-workspace-panel';
import { hasBrowserWorkspaceEvents } from '../../lib/chatflow/managed-browser-task-presenter';
import { assistantDelta } from './chatflow-utils';
import assistantUi from './dsh-upstream/AssistantMarkdown.module.css';
import chatUi from './dsh-upstream/ChatView.module.css';
import messageUi from './dsh-upstream/MessageItem.module.css';
import styles from './dsh-saas.module.css';
import {
  hasManagedBrowserEvents,
  ManagedBrowserTaskPanel,
} from './managed-browser-task-panel';
import { UserQuestionReceipt } from './user-question-receipt';
import { LocalCommandPanel } from './local-command-panel';
import { LocalMcpPanel } from './local-mcp-panel';
import { CloudOperationPanel } from './cloud-operation-panel';
import { ArtifactSummaryCards } from './artifact-workbench';
import { AssistantRunPanel } from './assistant-run-panel';
import { WorkProcess } from './work-process';
import { AssistantMessageActions } from './message-feedback';
import { MessageIconActions } from './dsh-upstream/feedback/MessageIconActions';
import { feedbackTranslate } from './feedback-labels';
import { presentAssistantTree } from '../../lib/chatflow/assistant-tree-presenter';
import { isMessageRunActive } from './run-view';

interface ChatTranscriptProps {
  messageImages?: MessageImageSource;
  streamingOutput?: boolean;
  atBottom: boolean;
  employeeName?: string;
  localCommandsEnabled?: boolean;
  localMcpEnabled?: boolean;
  assistantTrees?: Record<string, AssistantTreeView>;
  runTimings?: InteractionStatus['runTimings'];
  onAssistantChanged?: () => void;
  messages: Message[];
  recoverableRunView?: RunView;
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
}

export function ChatTranscript({
  messageImages,
  streamingOutput = false,
  atBottom,
  employeeName = 'AI 员工',
  localCommandsEnabled = false,
  localMcpEnabled = false,
  assistantTrees = {},
  runTimings = [],
  onAssistantChanged,
  messages,
  recoverableRunView,
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
}: ChatTranscriptProps) {
  const [browserRevisions, setBrowserRevisions] = useState<
    Record<string, number>
  >({});
  const timingByRun = new Map(
    runTimings.map((entry) => [entry.runId, entry.timing]),
  );
  return (
    <div className={chatUi.root}>
      <div className={chatUi.scroll} data-chat-scroll>
        <div className={chatUi.column} ref={transcriptColumn}>
          {messages
            .filter(
              (message) =>
                message.role !== 'assistant' ||
                message.status !== 'completed' ||
                message.content.text.length > 0 ||
                !!(
                  message.runId &&
                  assistantTrees[message.runId]?.instances.some(
                    (item) =>
                      item.parentRunId !== null && item.runId !== message.runId,
                  )
                ),
            )
            .map((message) => {
              const messageRun = message.runId
                ? (runViews[message.runId] ?? null)
                : null;
              const trace = message.runId
                ? runTraces[message.runId]
                : undefined;
              const assistantTree = message.runId
                ? assistantTrees[message.runId]
                : undefined;
              const assistantState = assistantTree
                ? presentAssistantTree(assistantTree)
                : undefined;
              const timing = message.runId
                ? (timingByRun.get(message.runId) ??
                  assistantTree?.timing ??
                  undefined)
                : undefined;
              const traceEvents = messageRun?.events ?? trace?.events ?? [];
              const messageIsRunning = isMessageRunActive(message, messageRun);
              const streamedText = messageRun
                ? assistantDelta(messageRun.events)
                : '';
              const linkedArtifacts = artifacts.filter(
                (a) => a.provenance.runId === message.runId,
              );
              const nativeFailure =
                message.status === 'failed'
                  ? (nativeExecutionFailureText(message.errorCode) ??
                    nativeExecutionDiagnosticFailureText(
                      message.errorCode,
                      traceEvents.findLast(
                        (event) => event.type === 'turn.failed',
                      )?.payload,
                      traceEvents.findLast(
                        (event) => event.type === 'run.failed',
                      )?.payload.message,
                    ))
                  : null;
              const fallbackText =
                (message.status === 'failed' &&
                !message.content.budgetWarning &&
                !nativeFailure
                  ? modelGovernanceFailureText(message.errorCode)
                  : null) ??
                (message.status === 'pending'
                  ? ''
                  : nativeFailure &&
                      message.content.text ===
                        'Rice 暂时无法完成这次请求，请稍后重试。'
                    ? nativeFailure
                    : message.content.text);
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
                  {message.role === 'user' &&
                  message.content.interaction?.type ===
                    'user_question_answer' ? (
                    <UserQuestionReceipt
                      answer={message.content.interaction.answer}
                      createdAt={message.createdAt}
                      text={message.content.text}
                    />
                  ) : message.role === 'user' &&
                    message.content.interaction?.type ===
                      'changeset_request' ? (
                    <div className={styles.messageMeta}>
                      <strong>
                        文件
                        {message.content.interaction.action.restoreOf
                          ? '恢复'
                          : '应用'}
                        请求 · 尚未授权执行
                      </strong>
                      <details>
                        <summary>查看请求</summary>
                        <p>{message.content.text}</p>
                      </details>
                    </div>
                  ) : message.role === 'user' &&
                    message.content.interaction?.type === 'review_response' ? (
                    <div className={styles.messageMeta}>
                      <strong>
                        {message.content.interaction.review.kind ===
                        'plan_review'
                          ? '计划已认可 · 不代表动作批准'
                          : '版本修订请求'}
                      </strong>
                      <span>
                        版本{' '}
                        {message.content.interaction.review.artifactId.slice(
                          0,
                          8,
                        )}
                      </span>
                      <details>
                        <summary>查看提交内容</summary>
                        <p>{message.content.text}</p>
                      </details>
                    </div>
                  ) : message.role === 'user' ? (
                    <div
                      className={messageUi.userRow}
                      data-actions-reveal="hover"
                    >
                      <div className={messageUi.userStack}>
                        <SessionReferenceChips
                          references={message.content.sessionReferences ?? []}
                        />
                        {message.content.companyAssets &&
                          (message.content.companyAssets.rules.length > 0 ||
                            message.content.companyAssets.templates.length >
                              0) && (
                            <details aria-label="本次采用的公司资料">
                              <summary>
                                本次公司资料 ·{' '}
                                {message.content.companyAssets.rules.length}{' '}
                                条规矩 ·{' '}
                                {message.content.companyAssets.templates.length}{' '}
                                项范本
                              </summary>
                              {message.content.companyAssets.rules.map(
                                (ref) => (
                                  <p key={ref.assetId}>
                                    规矩：{ref.revision.content.title} · v
                                    {ref.revision.number}
                                  </p>
                                ),
                              )}
                              {message.content.companyAssets.templates.map(
                                (ref) => (
                                  <div key={ref.assetId}>
                                    <p>
                                      范本：{ref.revision.content.title} · v
                                      {ref.revision.number}
                                    </p>
                                    {ref.revision.content.slots.map((slot) => (
                                      <p key={slot.key}>
                                        {slot.label}：
                                        {ref.parameters[slot.key] || '未填写'}
                                      </p>
                                    ))}
                                  </div>
                                ),
                              )}
                            </details>
                          )}
                        {messageImages && message.attachments?.length ? (
                          <MessageImageGallery
                            attachments={message.attachments}
                            source={messageImages}
                          />
                        ) : null}
                        <div
                          className={`${messageUi.bubble} ${styles.userBubble}`}
                        >
                          {message.content.text}
                        </div>
                      </div>
                      <MessageIconActions
                        text={message.content.text}
                        time={Date.parse(message.createdAt)}
                        clock="start"
                        t={feedbackTranslate}
                      />
                    </div>
                  ) : (
                    <div
                      className={assistantUi.root}
                      data-actions-reveal="hover"
                      data-working={
                        (messageIsRunning &&
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
                          return (
                            <>
                              {feedback}
                              <WorkProcess
                                items={timeline.items}
                                parts={timeline.parts}
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
                                assistantCount={
                                  assistantState?.children.length ?? 0
                                }
                                assistantAttention={
                                  assistantState?.attention.length ?? 0
                                }
                              >
                                {assistantTree &&
                                assistantState?.children.length &&
                                onAssistantChanged &&
                                onOpenArtifact ? (
                                  <AssistantRunPanel
                                    key={`${workspaceId}/${message.runId}`}
                                    tree={assistantTree}
                                    workspaceId={workspaceId}
                                    headers={tenantHeaders}
                                    onArtifact={onOpenArtifact}
                                    onChanged={onAssistantChanged}
                                  />
                                ) : null}
                              </WorkProcess>
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
                              {localMcpEnabled && message.runId && (
                                <LocalMcpPanel
                                  runId={message.runId}
                                  workspaceId={workspaceId}
                                  tenantHeaders={tenantHeaders}
                                  runActive={messageIsRunning}
                                />
                              )}
                              {responseText && !timeline.parts ? (
                                <div
                                  className={`${assistantUi.body} ${styles.assistantCopy}`}
                                  data-streaming={
                                    (messageIsRunning && !!streamedText) ||
                                    undefined
                                  }
                                >
                                  <AssistantMarkdown
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
                                <small role="status">
                                  答案已保留。本次任务超过平台内部预期 Token
                                  预算；真实用量已记录，这不代表 Codex
                                  周额度耗尽。
                                </small>
                              ) : message.status === 'failed' &&
                                !applicationFailure &&
                                responseText !== nativeFailure ? (
                                <small className={styles.failedMessage}>
                                  {message.errorCode ===
                                  'ASSISTANT_EXECUTION_UNRESOLVED'
                                    ? '本轮已结束，部分操作的结果仍待核实；不会自动重试。'
                                    : (nativeFailure ?? '这次没有完成。')}
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
                      {!messageIsRunning && responseText && message.runId ? (
                        <AssistantMessageActions
                          messageId={message.id}
                          text={responseText}
                          createdAt={message.createdAt}
                          workMethods={message.workMethods}
                        />
                      ) : null}
                    </div>
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
}
