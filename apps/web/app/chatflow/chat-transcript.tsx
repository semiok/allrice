'use client';

import { useState, type RefObject } from 'react';
import {
  modelGovernanceFailureText,
  type WorkbenchArtifact,
  type InteractionStatus,
} from '@allrice/contracts';
import type { AssistantTreeView } from '@allrice/database';

import { projectWorkProgress } from '../../lib/chatflow/work-progress';

import { AssistantMarkdown } from './assistant-markdown';
import { MessageImageGallery } from './attachment-components';
import type { Message, RunTrace, RunView } from './chatflow-types';
import { BrowserWorkspacePanel } from './browser-workspace-panel';
import { hasBrowserWorkspaceEvents } from '../../lib/chatflow/managed-browser-task-presenter';
import { assistantDelta, formatTime } from './chatflow-utils';
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
import { presentAssistantTree } from '../../lib/chatflow/assistant-tree-presenter';

interface ChatTranscriptProps {
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
              const messageIsRunning = messageRun
                ? messageRun.status === 'running' ||
                  messageRun.status === 'connecting'
                : message.status === 'pending';
              const streamedText = messageRun
                ? assistantDelta(messageRun.events)
                : '';
              const linkedArtifacts = artifacts.filter(
                (a) => a.provenance.runId === message.runId,
              );
              const fallbackText =
                (message.status === 'failed' && !message.content.budgetWarning
                  ? modelGovernanceFailureText(message.errorCode)
                  : null) ??
                (message.status === 'pending' ? '' : message.content.text);
              const progress = projectWorkProgress(
                traceEvents,
                fallbackText,
                messageIsRunning,
                streamingOutput,
              );
              const responseText = progress.finalText;
              const summarize =
                !!onOpenArtifact &&
                linkedArtifacts.length > 0 &&
                message.status === 'completed' &&
                !messageIsRunning &&
                responseText.length > 600;

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
                    <div className={messageUi.userRow}>
                      <div className={messageUi.userStack}>
                        {message.attachments?.length ? (
                          <MessageImageGallery
                            attachments={message.attachments}
                            tenantHeaders={tenantHeaders}
                          />
                        ) : null}
                        <div className={messageUi.bubble}>
                          {message.content.text}
                        </div>
                      </div>
                      <div className={styles.messageMeta}>
                        <span>你</span>
                        <time>{formatTime(message.createdAt)}</time>
                      </div>
                    </div>
                  ) : (
                    <div
                      className={assistantUi.root}
                      data-actions-reveal="hover"
                    >
                      <div className={styles.assistantIdentity}>
                        <i aria-hidden="true" />
                        <span>{employeeName}</span>
                        <time>{formatTime(message.createdAt)}</time>
                      </div>
                      <WorkProcess
                        items={progress.items}
                        parts={progress.parts}
                        timing={timing}
                        running={messageIsRunning}
                        streaming={streamingOutput && !!streamedText}
                        failed={
                          message.status === 'failed' ||
                          messageRun?.status === 'failed'
                        }
                        canceled={messageRun?.status === 'canceled'}
                        traceStatus={trace?.status}
                        onRetry={() => {
                          if (message.runId) void onLoadRunTrace(message.runId);
                        }}
                        assistantCount={assistantState?.children.length ?? 0}
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
                      {message.runId && hasManagedBrowserEvents(traceEvents) ? (
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
                            refreshKey={browserRevisions[message.runId] ?? 0}
                            runId={message.runId}
                            workspaceId={workspaceId}
                            tenantHeaders={tenantHeaders}
                            runActive={messageIsRunning}
                          />
                        )}
                      {message.runId && (
                        <CloudOperationPanel
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
                      {responseText ? (
                        <div
                          className={`${assistantUi.body} ${styles.assistantCopy}`}
                          data-streaming={
                            (messageIsRunning && !!streamedText) || undefined
                          }
                        >
                          {summarize ? (
                            <>
                              <p>
                                本轮已交付 {linkedArtifacts.length}{' '}
                                项成果，可在交付成果中查看与审查。
                              </p>
                              <details>
                                <summary>展开完整回复</summary>
                                <AssistantMarkdown
                                  text={responseText}
                                  artifacts={linkedArtifacts}
                                />
                              </details>
                            </>
                          ) : (
                            <AssistantMarkdown
                              text={responseText}
                              artifacts={linkedArtifacts}
                            />
                          )}
                        </div>
                      ) : null}
                      {message.content.budgetWarning &&
                      message.status === 'failed' ? (
                        <small role="status">
                          答案已保留。本次任务超过平台内部预期 Token
                          预算；真实用量已记录，这不代表 Codex 周额度耗尽。
                        </small>
                      ) : message.status === 'failed' ? (
                        <small className={styles.failedMessage}>
                          这次没有完成。
                        </small>
                      ) : null}
                      {onOpenArtifact && message.runId ? (
                        <ArtifactSummaryCards
                          artifacts={linkedArtifacts}
                          onOpen={onOpenArtifact}
                        />
                      ) : null}
                      {!messageIsRunning && responseText && message.runId ? (
                        <AssistantMessageActions
                          messageId={message.id}
                          text={responseText}
                          createdAt={message.createdAt}
                          timing={timing}
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}

          {recoverableRunView ? (
            <button
              className={styles.recover}
              onClick={() => void onRecoverRun(recoverableRunView.runId)}
              type="button"
            >
              重新连接并恢复执行记录
            </button>
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
