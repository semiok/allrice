'use client';

import type { SessionReference } from '@allrice/contracts';
import { SessionReferenceChips } from './session-reference-picker';

import type { MutableRefObject, RefObject, ReactNode } from 'react';

import { shouldSubmitComposerKey } from '../../lib/chatflow/composer-keyboard';

import { PendingAttachmentRail } from './attachment-components';
import {
  bridgeComposerStatus,
  type BridgeConnectionState,
} from './bridge-view';
import type { History, PendingAttachment, Visibility } from './chatflow-types';
import { resizeComposerTextarea } from './chatflow-utils';
import inputUi from './dsh-upstream/InputBar.module.css';
import styles from './dsh-saas.module.css';

interface ChatComposerProps {
  sessionReferences?: SessionReference[];
  onOpenSessionReferences?: () => void;
  onRemoveSessionReference?: (id: string) => void;
  employeeName: string;
  attachmentMenuOpen: boolean;
  busy: boolean;
  assistantModeControl?: ReactNode;
  composerInput: RefObject<HTMLTextAreaElement | null>;
  composing: MutableRefObject<boolean>;
  draft: string;
  error: string;
  fileInput: RefObject<HTMLInputElement | null>;
  hero?: boolean;
  isRunning: boolean;
  localWorkspaceLabel?: string;
  localWorkspaceOnline: boolean;
  bridgeConnectionState: BridgeConnectionState;
  nativeContextStatus: History['nativeContextStatus'];
  contextCompacting?: boolean;
  pendingAttachments: PendingAttachment[];
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
  sessionReferences = [],
  onOpenSessionReferences,
  onRemoveSessionReference,
  employeeName,
  attachmentMenuOpen,
  busy,
  assistantModeControl,
  composerInput,
  composing,
  draft,
  error,
  fileInput,
  hero = false,
  isRunning,
  localWorkspaceLabel,
  localWorkspaceOnline,
  bridgeConnectionState,
  nativeContextStatus,
  contextCompacting = false,
  pendingAttachments,
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
  const bridgeStatus = bridgeComposerStatus(
    bridgeConnectionState,
    localWorkspaceOnline,
    localWorkspaceLabel,
  );
  return (
    <div className={`${inputUi.root} ${hero ? inputUi.hero : ''}`}>
      {error ? <div className={inputUi.notice}>{error}</div> : null}
      <div className={inputUi.card}>
        <SessionReferenceChips
          references={sessionReferences}
          onRemove={onRemoveSessionReference}
          disabled={busy}
        />
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
          aria-label={`给 ${employeeName} 的消息`}
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
            hero
              ? `告诉 ${employeeName} 你想完成什么工作`
              : `继续和 ${employeeName} 工作…`
          }
          rows={hero ? 3 : 2}
          ref={composerInput}
          value={draft}
        />
        <div className={inputUi.row}>
          <div className={`${inputUi.tools} ${styles.composerTools}`}>
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
                  {onOpenSessionReferences && (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onAttachmentMenuOpenChange(false);
                        onOpenSessionReferences();
                      }}
                    >
                      <span aria-hidden="true">＠</span>
                      <span>
                        <strong>引用会话</strong>
                        <small>参考之前的工作内容</small>
                      </span>
                    </button>
                  )}
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
                accept=".docx,.xlsx,.pptx,.txt,.md,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif"
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
            {assistantModeControl}
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
          <div className={`${inputUi.trailing} ${styles.composerTrailing}`}>
            <button
              aria-label="发送"
              className={`${inputUi.primary} ${styles.employeeSend}`}
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
            aria-label={bridgeStatus.ariaLabel}
            className={`${styles.localWorkspaceStatus} ${
              bridgeStatus.online
                ? styles.localWorkspaceOnline
                : styles.localWorkspaceOffline
            }`}
            onClick={() => void onLoadBridgeDevices()}
            title={bridgeStatus.title}
            type="button"
          >
            <span aria-hidden="true" />
            {bridgeStatus.label}
          </button>
          {nativeContextStatus || contextCompacting ? (
            <span
              role="status"
              title={
                nativeContextStatus
                  ? `DSH 最近估算：约 ${nativeContextStatus.usedTokens.toLocaleString()} / ${nativeContextStatus.contextWindowTokens.toLocaleString()} tokens。自动整理会在窗口用满前触发；此百分比是占用量，不是压缩进度。`
                  : 'DSH 正在整理上下文，完成后继续工作。'
              }
            >
              {nativeContextStatus
                ? `上下文占用 ${nativeContextStatus.percentage}%`
                : ''}
              {contextCompacting
                ? `${nativeContextStatus ? ' · ' : ''}正在整理…`
                : ''}
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
