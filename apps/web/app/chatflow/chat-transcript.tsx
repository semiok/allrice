'use client';

import type { RefObject } from 'react';

import { projectNativeExperience } from '../../lib/chatflow/native-experience';

import { AssistantMarkdown } from './assistant-markdown';
import { MessageImageGallery } from './attachment-components';
import type { Message, RunTrace, RunView } from './chatflow-types';
import {
  assistantDelta,
  formatTime,
  nativeExperienceIcon,
} from './chatflow-utils';
import assistantUi from './dsh-upstream/AssistantMarkdown.module.css';
import chatUi from './dsh-upstream/ChatView.module.css';
import messageUi from './dsh-upstream/MessageItem.module.css';
import styles from './dsh-saas.module.css';
import {
  hasManagedBrowserEvents,
  ManagedBrowserTaskPanel,
} from './managed-browser-task-panel';

interface ChatTranscriptProps {
  atBottom: boolean;
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
}

export function ChatTranscript({
  atBottom,
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
}: ChatTranscriptProps) {
  return (
    <div className={chatUi.root}>
      <div className={chatUi.scroll} data-chat-scroll>
        <div className={chatUi.column} ref={transcriptColumn}>
          {messages.map((message) => {
            const messageRun = message.runId
              ? (runViews[message.runId] ?? null)
              : null;
            const trace = message.runId ? runTraces[message.runId] : undefined;
            const traceEvents = messageRun?.events ?? trace?.events ?? [];
            const nativeExperience = projectNativeExperience(traceEvents);
            const messageIsRunning =
              messageRun?.status === 'running' ||
              messageRun?.status === 'connecting';
            const streamedText = messageRun
              ? assistantDelta(messageRun.events)
              : '';

            return (
              <div className={chatUi.flowItem} key={message.id}>
                {message.role === 'user' ? (
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
                  <div className={assistantUi.root}>
                    <div className={styles.assistantIdentity}>
                      <i aria-hidden="true" />
                      <span>Rice</span>
                      {messageIsRunning ? (
                        <>
                          <span className={styles.runningDot} />
                          <span>正在工作</span>
                        </>
                      ) : null}
                      <time>{formatTime(message.createdAt)}</time>
                    </div>
                    {message.runId &&
                    (nativeExperience.length > 0 ||
                      messageIsRunning ||
                      trace?.status === 'loading' ||
                      trace?.status === 'failed') ? (
                      <div
                        className={styles.nativeTimeline}
                        aria-label="DSH 工作过程"
                      >
                        {nativeExperience.map((item) => (
                          <div
                            className={styles.nativeEvent}
                            data-kind={item.kind}
                            data-status={item.status}
                            key={item.id}
                          >
                            <span
                              className={styles.nativeEventIcon}
                              aria-hidden="true"
                            >
                              {nativeExperienceIcon(item.kind)}
                            </span>
                            <div>
                              <strong>{item.title}</strong>
                              {item.detail ? (
                                <small>{item.detail}</small>
                              ) : null}
                            </div>
                          </div>
                        ))}
                        {!nativeExperience.length &&
                        trace?.status === 'failed' ? (
                          <button
                            className={styles.nativeTraceRetry}
                            onClick={() => void onLoadRunTrace(message.runId!)}
                            type="button"
                          >
                            工作过程加载失败，点击重试
                          </button>
                        ) : null}
                        {!nativeExperience.length &&
                        trace?.status === 'loading' ? (
                          <div className={styles.nativeTraceState}>
                            正在恢复 DSH 工作过程…
                          </div>
                        ) : null}
                        {!nativeExperience.length &&
                        messageIsRunning &&
                        trace?.status !== 'loading' ? (
                          <div className={styles.nativeTraceState}>
                            DSH 正在准备本轮上下文…
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {message.runId && hasManagedBrowserEvents(traceEvents) ? (
                      <ManagedBrowserTaskPanel
                        runActive={messageIsRunning}
                        runId={message.runId}
                        tenantHeaders={tenantHeaders}
                        workspaceId={workspaceId}
                      />
                    ) : null}
                    {messageIsRunning && !streamedText ? (
                      <div className={chatUi.turnStatus}>
                        Rice 正在理解你的需求…
                      </div>
                    ) : (
                      <div
                        className={`${assistantUi.body} ${styles.assistantCopy}`}
                      >
                        <AssistantMarkdown
                          text={streamedText || message.content.text}
                        />
                      </div>
                    )}
                    {message.status === 'failed' ? (
                      <small className={styles.failedMessage}>
                        这次没有完成。
                      </small>
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
