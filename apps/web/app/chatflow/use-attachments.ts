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

import { officeMediaTypes, type DeliverableVersion } from '@allrice/contracts';

import type {
  Attachment,
  PendingAttachment,
  Visibility,
  Workspace,
  WorkspaceFile,
} from './chatflow-types';
import { fileToBase64, readJson } from './chatflow-utils';
import {
  localFileStatus,
  waitLocalFileCommand,
  type LocalFileCommandView,
} from './local-file-actions';
import type { BridgeDevice } from './chatflow-types';
import type { createSessionActions } from './session-actions';
import type { createSessionSelection } from './session-selection';

interface UseAttachmentsOptions {
  activeId: string | null;
  busy: boolean;
  captureSelection: ReturnType<typeof createSessionSelection>['capture'];
  sessionActions: ReturnType<typeof createSessionActions>;
  createSession: () => Promise<string | null>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  tenantHeaders: Record<string, string>;
  workspace: Workspace | null;
}

export interface WorkspaceFileAddResult {
  addedIds: string[];
  error?: string;
}

interface UseAttachmentsResult {
  addWorkspaceFiles: (
    files: WorkspaceFile[],
  ) => Promise<WorkspaceFileAddResult>;
  attachmentPreview: PendingAttachment | null;
  clearPendingAttachments: (retained?: ReadonlySet<string>) => void;
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
  uploadFromBridge: () => Promise<void>;
  cancelBridgeUpload: () => Promise<void>;
  bridgeUploadStatus: string | null;
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
  captureSelection,
  sessionActions,
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
    useState<Visibility>('workspace');
  const [bridgeFileCommand, setBridgeFileCommand] =
    useState<LocalFileCommandView | null>(null);
  const bridgeImportKey = useRef<{ scope: string; key: string } | null>(null);
  useEffect(() => {
    setBridgeFileCommand(null);
    // Keep the idempotency key through our own draft→created Session transition.
    if (
      !bridgeImportKey.current?.scope.startsWith(
        `${workspace?.workspaceId}/${activeId}/`,
      )
    )
      bridgeImportKey.current = null;
  }, [activeId, workspace?.workspaceId]);
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

  const clearPendingAttachments = useCallback(
    (retained?: ReadonlySet<string>) => {
      setPendingAttachments((current) => {
        for (const attachment of current) {
          if (attachment.previewUrl && !retained?.has(attachment.previewUrl))
            URL.revokeObjectURL(attachment.previewUrl);
        }
        return [];
      });
      setAttachmentPreview(null);
      setBridgeFileCommand(null);
    },
    [],
  );

  const changeUploadVisibility = useCallback(
    (update: SetStateAction<Visibility>) => {
      const next =
        typeof update === 'function' ? update(uploadVisibility) : update;
      setUploadVisibility(next);
      // The selector applies to this draft. Existing stored files retain their ACL.
      setPendingAttachments((current) =>
        current.map((attachment) =>
          attachment.persistedId
            ? attachment
            : { ...attachment, visibility: next },
        ),
      );
    },
    [uploadVisibility],
  );

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
          width: attachment.width,
          height: attachment.height,
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
          width: attachment.width,
          height: attachment.height,
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
        const officeType = (
          Object.keys(officeMediaTypes) as Array<keyof typeof officeMediaTypes>
        ).find((format) => lowerName.endsWith(`.${format}`));
        const mediaType =
          (file.type && file.type !== 'application/octet-stream'
            ? file.type
            : '') ||
          (officeType ? officeMediaTypes[officeType] : '') ||
          (lowerName.endsWith('.csv')
            ? 'text/csv'
            : lowerName.endsWith('.md')
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
          'text/csv',
          'text/markdown',
          'application/json',
          'application/pdf',
          ...Object.values(officeMediaTypes),
        ].includes(mediaType);
        if (!supportedImage && !supportedDocument) {
          rejection =
            '支持 Word（DOCX）、Excel（XLSX）、CSV、PPT（PPTX）、PDF、图片、TXT、MD 和 JSON。';
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
      // Native DSH intake probes intrinsic dimensions before submission, so the
      // local echo and admitted image share the same box.
      for (const attachment of accepted) {
        if (!attachment.previewUrl) continue;
        const probe = new Image();
        probe.onload = () => {
          attachment.width = probe.naturalWidth;
          attachment.height = probe.naturalHeight;
        };
        probe.src = attachment.previewUrl;
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
    const scope = captureSelection();
    try {
      const result = await readJson<{ files: WorkspaceFile[] }>(
        await fetch(`/api/v1/files?workspaceId=${workspace.workspaceId}`, {
          cache: 'no-store',
          headers: tenantHeaders,
        }),
      );
      if (!scope.current()) return;
      setWorkspaceFiles(result.files);
      setFilePickerOpen(true);
    } catch (cause) {
      if (scope.current())
        setError(cause instanceof Error ? cause.message : '工作区文件加载失败');
    }
  }, [captureSelection, setError, tenantHeaders, workspace]);

  const uploadFromBridge = useCallback(async () => {
    if (!workspace || busy) return;
    if (pendingAttachmentsRef.current.length >= 20) {
      setError('每条消息最多添加 20 个附件。');
      return;
    }
    const action = sessionActions.begin('composer');
    if (!action) return;
    setBusy(true);
    setError('');
    setBridgeFileCommand(null);
    try {
      const sessionId = activeId ?? (await createSession());
      if (
        !sessionId ||
        (!activeId && !action.adoptCreatedSession(sessionId)) ||
        !action.current()
      )
        return;
      const { devices } = await readJson<{ devices: BridgeDevice[] }>(
        await fetch(
          `/api/v1/bridge/devices?workspaceId=${workspace.workspaceId}`,
          { headers: tenantHeaders, cache: 'no-store' },
        ),
      );
      if (!action.current()) return;
      const device = devices.find(
        (d) =>
          d.status === 'online' &&
          d.folderGrants.length &&
          d.readiness?.some(
            (r) =>
              r.capability === 'local.file.select' &&
              ['ready', 'busy', 'preparing'].includes(r.state),
          ),
      );
      const grant = device?.folderGrants.at(-1);
      if (!device || !grant)
        throw Error('请连接支持文件交接的 Mac，并先在“我的电脑”选择目录。');
      const scope = `${workspace.workspaceId}/${sessionId}/${device.id}/${grant.id}`;
      if (bridgeImportKey.current?.scope !== scope)
        bridgeImportKey.current = { scope, key: crypto.randomUUID() };
      const command = await readJson<LocalFileCommandView>(
        await fetch('/api/v1/bridge/files', {
          method: 'POST',
          headers: { ...tenantHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            deviceId: device.id,
            folderGrantId: grant.id,
            sessionId,
            idempotencyKey: bridgeImportKey.current.key,
            action: 'select',
          }),
        }),
      );
      if (!action.current()) return;
      const terminal = await waitLocalFileCommand(
        command,
        workspace.workspaceId,
        tenantHeaders,
        (value) => {
          if (action.current()) setBridgeFileCommand(value);
        },
      );
      if (!action.current()) return;
      if (
        terminal.status !== 'succeeded' ||
        terminal.output?.status !== 'uploaded' ||
        !terminal.output.object
      ) {
        if (terminal.status !== 'unknown') bridgeImportKey.current = null;
        throw Error(localFileStatus(terminal));
      }
      const file = terminal.output.object;
      setPendingAttachments((current) =>
        current.some((a) => a.persistedId === file.objectId)
          ? current
          : [
              ...current,
              {
                id: file.objectId,
                persistedId: file.objectId,
                fileName: file.fileName,
                mediaType: file.mediaType,
                sizeBytes: file.sizeBytes,
                visibility: 'private',
                status: 'ready',
              },
            ],
      );
      bridgeImportKey.current = null;
    } catch (cause) {
      if (action.current())
        setError(cause instanceof Error ? cause.message : '电脑文件上传未完成');
    } finally {
      if (action.finish()) setBusy(false);
    }
  }, [
    activeId,
    busy,
    createSession,
    sessionActions,
    setBusy,
    setError,
    tenantHeaders,
    workspace,
  ]);

  const cancelBridgeUpload = useCallback(async () => {
    if (!bridgeFileCommand || !workspace) return;
    const scope = captureSelection();
    try {
      const command = await readJson<LocalFileCommandView>(
        await fetch(
          `/api/v1/bridge/files/${bridgeFileCommand.id}?workspaceId=${workspace.workspaceId}`,
          { method: 'POST', headers: tenantHeaders },
        ),
      );
      if (scope.current()) setBridgeFileCommand(command);
    } catch {
      if (scope.current())
        setError('电脑取消请求未确认，请检查连接或在原生文件窗口取消。');
    }
  }, [bridgeFileCommand, captureSelection, setError, tenantHeaders, workspace]);

  const openVersionHistory = useCallback(
    async (file: WorkspaceFile) => {
      if (
        !workspace ||
        file.category !== 'exports' ||
        file.deliverableVersion === null
      ) {
        return;
      }
      const scope = captureSelection();
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
        if (!scope.current()) return;
        setDeliverableVersions(result.versions);
      } catch (cause) {
        if (!scope.current()) return;
        setVersionHistoryFile(null);
        setError(cause instanceof Error ? cause.message : '版本历史加载失败');
      } finally {
        if (scope.current()) setVersionHistoryLoading(false);
      }
    },
    [captureSelection, setError, tenantHeaders, workspace],
  );

  const addWorkspaceFiles = useCallback(
    async (files: WorkspaceFile[]): Promise<WorkspaceFileAddResult> => {
      const result: WorkspaceFileAddResult = { addedIds: [] };
      if (!workspace)
        return { ...result, error: '工作区尚未加载，请稍后重试。' };
      const existing = pendingAttachmentsRef.current;
      const existingIds = new Set(
        existing.map((file) => file.persistedId ?? file.id),
      );
      const unique = [
        ...new Map(files.map((file) => [file.id, file])).values(),
      ];
      const selected = unique.filter((file) => !existingIds.has(file.id));
      if (existing.length + selected.length > 20)
        return { ...result, error: '每条消息最多添加 20 个附件。' };
      if (
        [...existing, ...selected].reduce(
          (sum, file) => sum + file.sizeBytes,
          0,
        ) >
        200 * 1024 * 1024
      )
        return { ...result, error: '每条消息的附件总大小不能超过 200 MB。' };
      const action = sessionActions.begin('composer');
      if (!action)
        return { ...result, error: '当前消息正在处理，请稍后再添加附件。' };
      setBusy(true);
      setError('');
      try {
        const sessionId = activeId ?? (await createSession());
        if (!sessionId) return result;
        if (!activeId && !action.adoptCreatedSession(sessionId)) return result;
        for (const file of selected) {
          if (!action.current()) return result;
          await readJson(
            await fetch(
              `/api/v1/sessions/${sessionId}/attachments?workspaceId=${workspace.workspaceId}`,
              {
                method: 'PUT',
                headers: {
                  'content-type': 'application/json',
                  ...tenantHeaders,
                },
                body: JSON.stringify({ objectId: file.id }),
              },
            ),
          );
          if (!action.current()) return result;
          result.addedIds.push(file.id);
          setPendingAttachments((current) => [
            ...current.filter(
              (item) => (item.persistedId ?? item.id) !== file.id,
            ),
            {
              ...file,
              persistedId: file.id,
              status: 'ready',
              visibility: file.visibility,
            },
          ]);
        }
        if (action.current()) setFilePickerOpen(false);
      } catch (cause) {
        if (action.current()) {
          result.error =
            cause instanceof Error ? cause.message : '文件添加失败，请重试。';
          setError(result.error);
        }
      } finally {
        if (action.finish()) setBusy(false);
      }
      return result;
    },
    [
      activeId,
      createSession,
      sessionActions,
      setBusy,
      setError,
      tenantHeaders,
      workspace,
    ],
  );

  return {
    addWorkspaceFiles,
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
    setUploadVisibility: changeUploadVisibility,
    setVersionHistoryFile,
    uploadAttachments,
    uploadFromBridge,
    cancelBridgeUpload,
    bridgeUploadStatus: bridgeFileCommand
      ? localFileStatus(bridgeFileCommand)
      : null,
    uploadVisibility,
    versionHistoryFile,
    versionHistoryLoading,
    workspaceFiles,
  };
}
