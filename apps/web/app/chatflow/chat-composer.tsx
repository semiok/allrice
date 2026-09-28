'use client';

import type { SessionReference } from '@allrice/contracts';
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
        <div className={`${inputUi.row} ${styles.composerRow}`}>
          <div className={`${inputUi.tools} ${styles.composerTools}`}>
            <div className={styles.attachmentMenuAnchor}>
              <Menu
                open={attachmentMenuOpen && !busy}
                side="top"
                align="start"
                portal
                compact
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
                  ...(onOpenSessionReferences
                    ? [
                        {
                          id: 'reference',
                          label: '引用会话',
                          icon: <IconLinkOutlineRegular size={17} />,
                        },
                      ]
                    : []),
                  {
                    id: 'workspace',
                    label: '从工作区添加',
                    icon: <IconFolderOpenOutlineRegular size={17} />,
                  },
                  {
                    id: 'upload',
                    label: '从本地上传',
                    icon: (
                      <svg
                        width="17"
                        height="17"
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
                  else if (id === 'upload') fileInput.current?.click();
                }}
              />
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
              aria-label="发送"
              className={`${inputUi.primary} ${styles.employeeSend}`}
              disabled={busy || !draft.trim()}
              onClick={() => void onSendMessage()}
              type="button"
            >
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
