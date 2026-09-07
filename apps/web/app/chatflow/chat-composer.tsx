'use client';

import type { MutableRefObject, RefObject } from 'react';

import { shouldSubmitComposerKey } from '../../lib/chatflow/composer-keyboard';

import { PendingAttachmentRail } from './attachment-components';
import type { History, PendingAttachment, Visibility } from './chatflow-types';
import { resizeComposerTextarea } from './chatflow-utils';
import inputUi from './dsh-upstream/InputBar.module.css';
import styles from './dsh-saas.module.css';

interface ChatComposerProps {
  attachmentMenuOpen: boolean;
  busy: boolean;
  composerInput: RefObject<HTMLTextAreaElement | null>;
  composing: MutableRefObject<boolean>;
  draft: string;
  error: string;
  fileInput: RefObject<HTMLInputElement | null>;
  hero?: boolean;
  isRunning: boolean;
  inputMode?: 'steer' | 'follow_up';
  canSteer?: boolean;
  onInputModeChange?: (mode: 'steer' | 'follow_up') => void;
  localWorkspaceLabel?: string;
  localWorkspaceOnline: boolean;
  nativeContextStatus: History['nativeContextStatus'];
  pendingAttachments: PendingAttachment[];
  providerLabel: string;
  uploadVisibility: Visibility;
  onAttachmentMenuOpenChange: (open: boolean) => void;
  onCancelRun: () => void | Promise<void>;
  onDraftChange: (draft: string) => void;
  onLoadBridgeDevices: () => void | Promise<void>;
  onOpenAttachment: (attachment: PendingAttachment) => void;
  onOpenWorkspaceFiles: () => void | Promise<void>;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onRetryAttachment: (attachment: PendingAttachment) => void;
  onSendMessage: () => void | Promise<void>;
  onUploadAttachments: (files: FileList | File[]) => void;
  onUploadVisibilityChange: (visibility: Visibility) => void;
}

export function ChatComposer({
  attachmentMenuOpen,
  busy,
  composerInput,
  composing,
  draft,
  error,
  fileInput,
  hero = false,
  isRunning,
  inputMode = 'follow_up',
  canSteer = false,
  onInputModeChange,
  localWorkspaceLabel,
  localWorkspaceOnline,
  nativeContextStatus,
  pendingAttachments,
  providerLabel,
  uploadVisibility,
  onAttachmentMenuOpenChange,
  onCancelRun,
  onDraftChange,
  onLoadBridgeDevices,
  onOpenAttachment,
  onOpenWorkspaceFiles,
  onRemoveAttachment,
  onRetryAttachment,
  onSendMessage,
  onUploadAttachments,
  onUploadVisibilityChange,
}: ChatComposerProps) {
  return (
    <div className={`${inputUi.root} ${hero ? inputUi.hero : ''}`}>
      {error ? <div className={inputUi.notice}>{error}</div> : null}
      <div className={inputUi.card}>
        {isRunning && onInputModeChange ? (
          <label className={inputUi.notice}>
            发送方式：
            <select
              aria-label="运行中输入意图"
              value={inputMode}
              onChange={(e) =>
                onInputModeChange(e.target.value as 'steer' | 'follow_up')
              }
            >
              <option value="follow_up">排队，作为下一轮任务</option>
              <option
                value="steer"
                disabled={!canSteer || pendingAttachments.length > 0}
              >
                补充／纠正当前回合
              </option>
            </select>
            <small>
              {inputMode === 'steer'
                ? '仅发送到当前回合；失效后不会自动转成新任务。'
                : '当前任务继续，新消息按顺序处理。'}
            </small>
          </label>
        ) : null}
        {pendingAttachments.length ? (
          <PendingAttachmentRail
            attachments={pendingAttachments}
            disabled={busy}
            onOpen={onOpenAttachment}
            onRemove={onRemoveAttachment}
            onRetry={onRetryAttachment}
          />
        ) : null}
        <textarea
          aria-label="给 Rice 的消息"
          className={styles.composerInput}
          disabled={busy}
          onChange={(event) => {
            onDraftChange(event.target.value);
            resizeComposerTextarea(event.currentTarget);
          }}
          onCompositionEnd={() => {
            window.setTimeout(() => {
              composing.current = false;
            }, 10);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onKeyDown={(event) => {
            if (
              !shouldSubmitComposerKey(
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  repeat: event.repeat,
                  nativeIsComposing: event.nativeEvent.isComposing,
                  nativeKeyCode: event.nativeEvent.keyCode,
                },
                composing.current,
              )
            )
              return;
            event.preventDefault();
            void onSendMessage();
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith('image/'),
            );
            if (!files.length) return;
            event.preventDefault();
            onUploadAttachments(files);
          }}
          placeholder={
            hero ? '告诉 Rice 你想完成什么工作' : '继续和 Rice 工作…'
          }
          rows={hero ? 3 : 2}
          ref={composerInput}
          value={draft}
        />
        <div className={inputUi.row}>
          <div className={inputUi.tools}>
            <div className={styles.attachmentMenuAnchor}>
              <button
                aria-expanded={attachmentMenuOpen}
                aria-label="添加文件"
                className={inputUi.add}
                disabled={busy}
                onClick={() => onAttachmentMenuOpenChange(!attachmentMenuOpen)}
                type="button"
              >
                ＋
              </button>
              {attachmentMenuOpen ? (
                <div className={styles.attachmentMenu} role="menu">
                  <button
                    onClick={() => {
                      onAttachmentMenuOpenChange(false);
                      void onOpenWorkspaceFiles();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span aria-hidden="true">◇</span>
                    <span>
                      <strong>从工作区添加</strong>
                      <small>使用已有的工作区文件</small>
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      onAttachmentMenuOpenChange(false);
                      fileInput.current?.click();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <span aria-hidden="true">↑</span>
                    <span>
                      <strong>从本地上传</strong>
                      <small>上传后选择私有或工作区公开</small>
                    </span>
                  </button>
                </div>
              ) : null}
              <input
                accept=".txt,.md,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif"
                hidden
                onChange={(event) => {
                  if (event.target.files) {
                    onUploadAttachments(event.target.files);
                  }
                }}
                multiple
                ref={fileInput}
                type="file"
              />
            </div>
            <select
              aria-label="上传文件可见范围"
              className={inputUi.select}
              onChange={(event) =>
                onUploadVisibilityChange(event.target.value as Visibility)
              }
              value={uploadVisibility}
            >
              <option value="private">保持私有</option>
              <option value="workspace">工作区公开</option>
            </select>
          </div>
          <div className={inputUi.trailing}>
            <span className={styles.providerChip}>{providerLabel}</span>
            <button
              aria-label="发送"
              className={inputUi.primary}
              disabled={busy || !draft.trim()}
              onClick={() => void onSendMessage()}
              type="button"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
      <div className={styles.composerStatus}>
        <div className={styles.composerStatusLeft}>
          <button
            aria-label={
              localWorkspaceOnline
                ? `本地工作区 ${localWorkspaceLabel}`
                : '本地工作区离线'
            }
            className={`${styles.localWorkspaceStatus} ${
              localWorkspaceOnline
                ? styles.localWorkspaceOnline
                : styles.localWorkspaceOffline
            }`}
            onClick={() => void onLoadBridgeDevices()}
            title={
              localWorkspaceOnline
                ? `Rice Bridge 已连接：${localWorkspaceLabel}`
                : localWorkspaceLabel
                  ? `${localWorkspaceLabel} 已选择，但 Rice Bridge 当前离线`
                  : '尚未连接 Rice Bridge 或选择本地授权文件夹'
            }
            type="button"
          >
            <span aria-hidden="true" />
            {localWorkspaceLabel ?? '本地工作区离线'}
          </button>
          {nativeContextStatus ? (
            <span
              title={`DSH 原生上下文投影：约 ${nativeContextStatus.usedTokens.toLocaleString()} / ${nativeContextStatus.contextWindowTokens.toLocaleString()} tokens`}
            >
              Session 上下文 {nativeContextStatus.percentage}%
            </span>
          ) : null}
        </div>
        {isRunning ? (
          <button onClick={() => void onCancelRun()} type="button">
            停止本轮
          </button>
        ) : null}
      </div>
    </div>
  );
}
