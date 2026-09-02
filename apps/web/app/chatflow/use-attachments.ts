'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import type { DeliverableVersion } from '@allrice/contracts';

import type {
  Attachment,
  PendingAttachment,
  Visibility,
  Workspace,
  WorkspaceFile,
} from './chatflow-types';
import { fileToBase64, readJson } from './chatflow-utils';

interface UseAttachmentsOptions {
  activeId: string | null;
  busy: boolean;
  createSession: () => Promise<string | null>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  tenantHeaders: Record<string, string>;
  workspace: Workspace | null;
}

interface UseAttachmentsResult {
  addWorkspaceFile: (file: WorkspaceFile) => Promise<void>;
  attachmentPreview: PendingAttachment | null;
  clearPendingAttachments: () => void;
  deliverableVersions: DeliverableVersion[];
  fileInput: RefObject<HTMLInputElement | null>;
  filePickerOpen: boolean;
  openVersionHistory: (file: WorkspaceFile) => Promise<void>;
  openWorkspaceFiles: () => Promise<void>;
  pendingAttachments: PendingAttachment[];
  persistPendingAttachment: (
    attachment: PendingAttachment,
    sessionId: string,
  ) => Promise<Attachment>;
  removePendingAttachment: (target: PendingAttachment) => void;
  setAttachmentPreview: Dispatch<SetStateAction<PendingAttachment | null>>;
  setFilePickerOpen: Dispatch<SetStateAction<boolean>>;
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  setUploadVisibility: Dispatch<SetStateAction<Visibility>>;
  setVersionHistoryFile: Dispatch<SetStateAction<WorkspaceFile | null>>;
  uploadAttachments: (files: FileList | File[]) => void;
  uploadVisibility: Visibility;
  versionHistoryFile: WorkspaceFile | null;
  versionHistoryLoading: boolean;
  workspaceFiles: WorkspaceFile[];
}

/**
 * Owns ChatFlow's draft-attachment lifecycle and workspace file picker state.
 * Network payloads and upload limits deliberately mirror the original facade.
 */
export function useAttachments({
  activeId,
  busy,
  createSession,
  setBusy,
  setError,
  tenantHeaders,
  workspace,
}: UseAttachmentsOptions): UseAttachmentsResult {
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [attachmentPreview, setAttachmentPreview] =
    useState<PendingAttachment | null>(null);
  const [uploadVisibility, setUploadVisibility] =
    useState<Visibility>('private');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [versionHistoryFile, setVersionHistoryFile] =
    useState<WorkspaceFile | null>(null);
  const [deliverableVersions, setDeliverableVersions] = useState<
    DeliverableVersion[]
  >([]);
  const [versionHistoryLoading, setVersionHistoryLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  pendingAttachmentsRef.current = pendingAttachments;

  useEffect(
    () => () => {
      for (const attachment of pendingAttachmentsRef.current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
    },
    [],
  );

  const clearPendingAttachments = useCallback(() => {
    setPendingAttachments((current) => {
      for (const attachment of current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
    setAttachmentPreview(null);
  }, []);

  const removePendingAttachment = useCallback((target: PendingAttachment) => {
    if (target.previewUrl) URL.revokeObjectURL(target.previewUrl);
    setAttachmentPreview((current) =>
      current?.id === target.id ? null : current,
    );
    setPendingAttachments((current) =>
      current.filter((attachment) => attachment.id !== target.id),
    );
  }, []);

  const persistPendingAttachment = useCallback(
    async (
      attachment: PendingAttachment,
      sessionId: string,
    ): Promise<Attachment> => {
      if (!workspace) throw new Error('工作区尚未加载');
      if (attachment.persistedId) {
        return {
          id: attachment.persistedId,
          fileName: attachment.fileName,
          mediaType: attachment.mediaType,
          sizeBytes: attachment.sizeBytes,
          ...(attachment.previewUrl
            ? { previewUrl: attachment.previewUrl }
            : {}),
        };
      }
      if (!attachment.file) throw new Error(`${attachment.fileName} 已不可用`);

      setPendingAttachments((current) =>
        current.map((item) =>
          item.id === attachment.id
            ? { ...item, status: 'uploading', error: undefined }
            : item,
        ),
      );
      try {
        const result = await readJson<{ attachment: Attachment }>(
          await fetch(
            `/api/v1/sessions/${sessionId}/attachments?workspaceId=${workspace.workspaceId}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...tenantHeaders },
              body: JSON.stringify({
                fileName: attachment.fileName,
                mediaType: attachment.mediaType,
                contentBase64: await fileToBase64(attachment.file),
                visibility: attachment.visibility,
              }),
            },
          ),
        );
        setPendingAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? {
                  ...item,
                  persistedId: result.attachment.id,
                  status: 'ready',
                  error: undefined,
                }
              : item,
          ),
        );
        return {
          ...result.attachment,
          ...(attachment.previewUrl
            ? { previewUrl: attachment.previewUrl }
            : {}),
        };
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '文件上传失败';
        setPendingAttachments((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? { ...item, status: 'failed', error: message }
              : item,
          ),
        );
        throw new Error(`${attachment.fileName}：${message}`);
      }
    },
    [tenantHeaders, workspace],
  );

  const uploadAttachments = useCallback(
    (files: FileList | File[]) => {
      if (busy) {
        setError('当前消息正在发送，请稍后再添加附件。');
        return;
      }
      const selected = [...files];
      if (!selected.length) return;
      if (pendingAttachments.length + selected.length > 20) {
        setError('每条消息最多添加 20 个附件。');
        return;
      }

      const accepted: PendingAttachment[] = [];
      let rejection = '';
      for (const file of selected) {
        const lowerName = file.name.toLowerCase();
        const mediaType =
          file.type ||
          (lowerName.endsWith('.md')
            ? 'text/markdown'
            : lowerName.endsWith('.txt')
              ? 'text/plain'
              : lowerName.endsWith('.json')
                ? 'application/json'
                : lowerName.endsWith('.pdf')
                  ? 'application/pdf'
                  : lowerName.endsWith('.gif')
                    ? 'image/gif'
                    : '');
        const supportedImage = [
          'image/png',
          'image/jpeg',
          'image/webp',
          'image/gif',
        ].includes(mediaType);
        const supportedDocument = [
          'text/plain',
          'text/markdown',
          'application/json',
          'application/pdf',
        ].includes(mediaType);
        if (!supportedImage && !supportedDocument) {
          rejection = '仅支持 PNG、JPG、WebP、GIF、PDF、TXT、MD 和 JSON。';
          continue;
        }
        const sizeLimit = supportedImage ? 20 * 1024 * 1024 : 8_000_000;
        if (file.size > sizeLimit) {
          rejection = supportedImage
            ? '每张图片不能超过 20 MB。'
            : '附件不能超过 8 MB。';
          continue;
        }
        accepted.push({
          id: crypto.randomUUID(),
          persistedId: null,
          fileName: file.name,
          mediaType,
          sizeBytes: file.size,
          ...(supportedImage ? { previewUrl: URL.createObjectURL(file) } : {}),
          status: 'draft',
          visibility: uploadVisibility,
          file,
        });
      }

      const totalBytes = [...pendingAttachments, ...accepted].reduce(
        (sum, attachment) => sum + attachment.sizeBytes,
        0,
      );
      if (totalBytes > 200 * 1024 * 1024) {
        for (const attachment of accepted) {
          if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
        }
        setError('每条消息的附件总大小不能超过 200 MB。');
        return;
      }
      if (accepted.length) {
        setPendingAttachments((current) => [...current, ...accepted]);
        setError(rejection);
      } else if (rejection) {
        setError(rejection);
      }
      if (fileInput.current) fileInput.current.value = '';
    },
    [busy, pendingAttachments, setError, uploadVisibility],
  );

  const openWorkspaceFiles = useCallback(async () => {
    if (!workspace) return;
    try {
      const result = await readJson<{ files: WorkspaceFile[] }>(
        await fetch(`/api/v1/files?workspaceId=${workspace.workspaceId}`, {
          cache: 'no-store',
          headers: tenantHeaders,
        }),
      );
      setWorkspaceFiles(result.files);
      setFilePickerOpen(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工作区文件加载失败');
    }
  }, [setError, tenantHeaders, workspace]);

  const openVersionHistory = useCallback(
    async (file: WorkspaceFile) => {
      if (
        !workspace ||
        file.category !== 'exports' ||
        file.deliverableVersion === null
      ) {
        return;
      }
      setFilePickerOpen(false);
      setVersionHistoryFile(file);
      setDeliverableVersions([]);
      setVersionHistoryLoading(true);
      try {
        const result = await readJson<{ versions: DeliverableVersion[] }>(
          await fetch(
            `/api/v1/files/${file.id}/versions?workspaceId=${workspace.workspaceId}`,
            { cache: 'no-store', headers: tenantHeaders },
          ),
        );
        setDeliverableVersions(result.versions);
      } catch (cause) {
        setVersionHistoryFile(null);
        setError(cause instanceof Error ? cause.message : '版本历史加载失败');
      } finally {
        setVersionHistoryLoading(false);
      }
    },
    [setError, tenantHeaders, workspace],
  );

  const addWorkspaceFile = useCallback(
    async (file: WorkspaceFile) => {
      if (!workspace) return;
      setBusy(true);
      try {
        const sessionId = activeId ?? (await createSession());
        if (!sessionId) return;
        await readJson(
          await fetch(
            `/api/v1/sessions/${sessionId}/attachments?workspaceId=${workspace.workspaceId}`,
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json', ...tenantHeaders },
              body: JSON.stringify({ objectId: file.id }),
            },
          ),
        );
        setPendingAttachments((current) => [
          ...current.filter((item) => item.id !== file.id),
          {
            ...file,
            persistedId: file.id,
            status: 'ready',
            visibility: file.visibility,
          },
        ]);
        setFilePickerOpen(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '文件添加失败');
      } finally {
        setBusy(false);
      }
    },
    [activeId, createSession, setBusy, setError, tenantHeaders, workspace],
  );

  return {
    addWorkspaceFile,
    attachmentPreview,
    clearPendingAttachments,
    deliverableVersions,
    fileInput,
    filePickerOpen,
    openVersionHistory,
    openWorkspaceFiles,
    pendingAttachments,
    persistPendingAttachment,
    removePendingAttachment,
    setAttachmentPreview,
    setFilePickerOpen,
    setPendingAttachments,
    setUploadVisibility,
    setVersionHistoryFile,
    uploadAttachments,
    uploadVisibility,
    versionHistoryFile,
    versionHistoryLoading,
    workspaceFiles,
  };
}
