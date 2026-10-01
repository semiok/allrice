'use client';

import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import type {
  SessionReference,
  TaskSuggestionDisplay,
  WorkspaceReadiness,
} from '@allrice/contracts';
import { TaskSuggestions } from './task-suggestions';
import type { PreparedComposerDraft } from '../../lib/chatflow/composer-draft';
import { SessionReferenceChips } from './session-reference-picker';

import type { MutableRefObject, RefObject, ReactNode } from 'react';
import {
  IconPlusOutlineRegular,
  IconGlobeOutlineRegular,
  IconFolderOpenOutlineRegular,
  IconLinkOutlineRegular,
  Menu,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ComposerSelect } from './composer-select';

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
  taskSuggestions?: TaskSuggestionDisplay[];
  taskScope?: string;
  compact?: boolean;
  taskReadiness?: WorkspaceReadiness | null;
  onPrepareTask?: (prepared: PreparedComposerDraft) => void;
  onTaskPreparation?: (preparation: 'files' | 'bridge' | 'connections') => void;
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
  cancelPending?: boolean;
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
  onUploadFromBridge?: () => void | Promise<void>;
  onCancelBridgeUpload?: () => void | Promise<void>;
  bridgeUploadStatus?: string | null;
  onUploadVisibilityChange: (visibility: Visibility) => void;
}

export function ChatComposer({
  taskSuggestions,
  taskScope,
  compact = false,
  taskReadiness = null,
  onPrepareTask,
  onTaskPreparation,
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
  cancelPending = false,
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
  onUploadFromBridge,
  onCancelBridgeUpload,
  bridgeUploadStatus,
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
      {bridgeUploadStatus ? (
        <div className={inputUi.notice} role="status">
          {bridgeUploadStatus}{' '}
          {busy && onCancelBridgeUpload && (
            <button type="button" onClick={() => void onCancelBridgeUpload()}>
              取消电脑上传
            </button>
          )}
        </div>
      ) : null}
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
        {taskSuggestions && onPrepareTask && onTaskPreparation && (
          <TaskSuggestions
            key={taskScope}
            suggestions={taskSuggestions}
            draft={draft}
            busy={busy}
            hero={hero}
            compact={compact}
            attachmentCount={pendingAttachments.length}
            readiness={taskReadiness}
            onPrepare={onPrepareTask}
            onPreparation={onTaskPreparation}
          />
        )}
        <div className={`${inputUi.row} ${styles.composerRow}`}>
          <div className={`${inputUi.tools} ${styles.composerTools}`}>
            <div className={styles.attachmentMenuAnchor}>
              <Menu
                open={attachmentMenuOpen && !busy}
                side="top"
                align="start"
                portal
                listClassName={styles.composerAttachmentMenu}
                onClose={() => onAttachmentMenuOpenChange(false)}
                anchor={
                  <button
                    aria-expanded={attachmentMenuOpen && !busy}
                    aria-haspopup="menu"
                    aria-label="添加文件"
                    className={styles.composerAdd}
                    disabled={busy}
                    onClick={() =>
                      onAttachmentMenuOpenChange(!attachmentMenuOpen)
                    }
                    type="button"
                  >
                    <IconPlusOutlineRegular size={19} aria-hidden="true" />
                  </button>
                }
                items={[
                  { type: 'label', id: 'heading', text: '添加到本轮' },
                  ...(onOpenSessionReferences
                    ? [
                        {
                          id: 'reference',
                          label: '引用会话',
                          icon: <IconLinkOutlineRegular size={20} />,
                        },
                      ]
                    : []),
                  {
                    id: 'workspace',
                    label: '从工作区添加',
                    icon: <IconFolderOpenOutlineRegular size={20} />,
                  },
                  ...(onUploadFromBridge
                    ? [
                        {
                          id: 'bridge-file',
                          label: '通过我的电脑选择文件',
                          icon: <IconFolderOpenOutlineRegular size={20} />,
                        },
                      ]
                    : []),
                  {
                    id: 'upload',
                    label: '从本地上传',
                    icon: (
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="m7 8 5-5 5 5M12 3v12M4 15v5h16v-5" />
                      </svg>
                    ),
                  },
                ]}
                onSelect={(id) => {
                  onAttachmentMenuOpenChange(false);
                  if (id === 'reference') onOpenSessionReferences?.();
                  else if (id === 'workspace') void onOpenWorkspaceFiles();
                  else if (id === 'bridge-file') void onUploadFromBridge?.();
                  else if (id === 'upload') fileInput.current?.click();
                }}
              />
              <input
                accept=".docx,.xlsx,.pptx,.csv,.txt,.md,.json,.pdf,.png,.jpg,.jpeg,.webp,.gif"
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
            <ComposerSelect
              aria-label="上传文件可见范围"
              compact="visibility"
              disabled={busy}
              title={
                uploadVisibility === 'workspace'
                  ? '新上传的文件：工作区成员可见'
                  : '新上传的文件：仅自己可见'
              }
              label={
                uploadVisibility === 'workspace' ? (
                  <>
                    <span className={styles.composerVisibilityScope}>
                      工作区
                    </span>
                    公开
                  </>
                ) : (
                  '私有'
                )
              }
              icon={
                uploadVisibility === 'workspace' ? (
                  <IconGlobeOutlineRegular size={16} />
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="5" y="10" width="14" height="11" rx="3" />
                    <path d="M8 10V7a4 4 0 0 1 8 0v3M12 15v2" />
                  </svg>
                )
              }
              onChange={(event) =>
                onUploadVisibilityChange(event.target.value as Visibility)
              }
              value={uploadVisibility}
            >
              <option value="workspace">工作区公开</option>
              <option value="private">私有 · 仅自己可见</option>
            </ComposerSelect>
          </div>
          <div className={`${inputUi.trailing} ${styles.composerTrailing}`}>
            <button
              aria-label={
                isRunning ? (cancelPending ? '正在停止' : '停止生成') : '发送'
              }
              title={
                isRunning
                  ? cancelPending
                    ? '正在等待任务停止'
                    : '停止本轮任务'
                  : '发送消息'
              }
              className={`${inputUi.primary} ${isRunning ? styles.employeeStop : styles.employeeSend}`}
              disabled={isRunning ? cancelPending : busy || !draft.trim()}
              onClick={() => void (isRunning ? onCancelRun() : onSendMessage())}
              type="button"
            >
              {isRunning ? (
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <rect x="1" y="1" width="14" height="14" rx="2" />
                </svg>
              ) : (
                <svg
                  aria-hidden="true"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.65"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5 12 7-7 7 7M12 19V5" />
                </svg>
              )}
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
                  ? `${contextCompacting ? '正在整理上下文，完成后继续工作。' : ''}DSH 最近估算：约 ${nativeContextStatus.usedTokens.toLocaleString()} / ${nativeContextStatus.contextWindowTokens.toLocaleString()} tokens。自动整理会在窗口用满前触发；此百分比是占用量，不是压缩进度。`
                  : 'DSH 正在整理上下文，完成后继续工作。'
              }
            >
              {nativeContextStatus
                ? `上下文占用 ${nativeContextStatus.percentage}%`
                : ''}
              {contextCompacting ? (
                <span
                  role="img"
                  aria-label="正在整理上下文"
                  className={styles.contextCompacting}
                >
                  <IconRefreshOutlineRegular />
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
