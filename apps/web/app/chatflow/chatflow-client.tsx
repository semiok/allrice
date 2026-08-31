'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  ChatFlowEventEnvelope,
  SaasCapabilityManifest,
} from '@allrice/contracts';

import { shouldSubmitComposerKey } from '../../lib/chatflow/composer-keyboard';
import { isConversationAtBottom } from '../../lib/chatflow/conversation-scroll';
import { projectNativeExperience } from '../../lib/chatflow/native-experience';
import { mergeChatFlowEvents } from '../../lib/chatflow/run-event-buffer';

import { AssistantMarkdown } from './assistant-markdown';
import assistantUi from './dsh-upstream/AssistantMarkdown.module.css';
import chatUi from './dsh-upstream/ChatView.module.css';
import conversationUi from './dsh-upstream/ConversationRoot.module.css';
import frameUi from './dsh-upstream/AppFrame.module.css';
import inputUi from './dsh-upstream/InputBar.module.css';
import messageUi from './dsh-upstream/MessageItem.module.css';
import sidebarUi from './dsh-upstream/SidebarRoot.module.css';
import { DshDialog } from './dsh-upstream/Dialog';
import styles from './dsh-saas.module.css';

type Visibility = 'private' | 'workspace' | 'organization';

interface Session {
  id: string;
  title: string;
  employeeAssignmentId: string;
  employeeVersionId: string;
  visibility: Visibility;
  updatedAt: string;
  archivedAt: string | null;
}

interface EmployeeVersion {
  id: string;
  manifest: {
    name: string;
    description?: string;
    runtimePolicy?: {
      harness: 'codex' | 'dsh';
      provider?: string;
      model?: string;
    };
    provider?: { provider: string };
  };
}

interface Employee {
  id: string;
  employeeId: string;
  isDefault: boolean;
  currentVersion: EmployeeVersion;
  versions: EmployeeVersion[];
}

interface EmployeeProfile {
  assignmentId: string;
  employeeId: string;
  name: string;
  description: string;
  identity: {
    role: string;
    mission: string;
    workStyle: string;
    behaviorRules: string[];
    safetyBoundaries: string[];
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  model: {
    harness: 'dsh';
    provider: string;
    model: string;
    reasoningEffort: string;
  };
}

interface Workspace {
  organizationId: string;
  workspaceId: string;
  employees: Employee[];
  employeeProfiles: EmployeeProfile[];
  sessions: Session[];
  sessionModels: Array<{
    sessionId: string;
    harness: 'dsh';
    provider: string;
    model: string;
    reasoningEffort: string;
  }>;
  canAdminister: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: { text: string };
  status: 'pending' | 'completed' | 'failed';
  runId: string | null;
  createdAt: string;
  attachments?: Attachment[];
}

interface History {
  session: Session;
  messages: Message[];
  contextStatus: {
    percentage: number;
    pressureTokens: number;
    thresholdTokens: number;
    compactionDue: boolean;
  };
  nativeContextStatus: {
    source: 'dsh';
    usedTokens: number;
    contextWindowTokens: number;
    percentage: number;
    asOfSeq: number | null;
    observedAt: string | null;
  } | null;
}

interface Attachment {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  previewUrl?: string;
}

interface PendingAttachment extends Attachment {
  persistedId: string | null;
  status: 'draft' | 'uploading' | 'ready' | 'failed';
  visibility: Visibility;
  file?: File;
  error?: string;
}

interface WorkspaceFile extends Attachment {
  visibility: Visibility;
  ownedByMe: boolean;
}

interface BridgeDevice {
  id: string;
  name: string;
  platform: 'macos-arm64';
  status: 'online' | 'offline' | 'revoked';
  lastSeenAt: string | null;
  folderGrants: Array<{
    id: string;
    label: string;
  }>;
}

interface RunView {
  runId: string;
  status: 'connecting' | 'running' | 'completed' | 'failed' | 'canceled';
  cursor: string | null;
  reconnects: number;
  events: ChatFlowEventEnvelope[];
}

interface RunTrace {
  status: 'loading' | 'loaded' | 'failed';
  events: ChatFlowEventEnvelope[];
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login?next=/chatflow');
    throw new Error('登录状态已失效');
  }
  const body = (await response.json().catch(() => null)) as
    T | { error?: { message?: string } } | null;
  if (!response.ok) {
    throw new Error(
      (body as { error?: { message?: string } } | null)?.error?.message ??
        `请求失败（${response.status}）`,
    );
  }
  return body as T;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

async function fileToBase64(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('文件读取失败'));
    reader.onload = () => {
      const value = reader.result;
      if (typeof value !== 'string') {
        reject(new Error('文件读取失败'));
        return;
      }
      resolve(value.slice(value.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function employeeForSession(workspace: Workspace, session: Session) {
  return workspace.employees.find(
    (employee) =>
      employee.id === session.employeeAssignmentId ||
      employee.versions.some(
        (version) => version.id === session.employeeVersionId,
      ),
  );
}

function providerForEmployee(employee?: Employee) {
  const manifest = employee?.currentVersion.manifest;
  const provider = manifest?.runtimePolicy?.provider;
  if (provider === 'openai-codex' || provider === 'codex') {
    return 'Codex 订阅 · DSH';
  }
  if (provider === 'deepseek-official') return 'DeepSeek · DSH';
  if (provider === 'openai-compatible') return 'API 模型 · DSH';
  return 'DSH';
}

function providerForSession(workspace: Workspace, session?: Session) {
  const frozen = workspace.sessionModels.find(
    (snapshot) => snapshot.sessionId === session?.id,
  );
  if (!frozen) {
    return providerForEmployee(
      session ? employeeForSession(workspace, session) : undefined,
    );
  }
  if (frozen.provider === 'openai-codex') return 'Codex 订阅 · DSH';
  if (frozen.provider === 'deepseek-official') return 'DeepSeek · DSH';
  if (/minimax/i.test(frozen.model)) return 'MiniMax · DSH';
  return `${frozen.model} · DSH`;
}

function providerDisplayName(provider: string) {
  if (provider === 'openai-codex' || provider === 'codex') return 'Codex 订阅';
  if (provider === 'deepseek-official' || provider === 'deepseek') {
    return 'DeepSeek API';
  }
  if (provider === 'openai-compatible') return '兼容 API';
  return provider;
}

function reasoningDisplayName(reasoningEffort: string) {
  return (
    {
      none: '关闭',
      low: '低',
      medium: '中',
      high: '高',
      xhigh: '极高',
    }[reasoningEffort] ?? reasoningEffort
  );
}

function assistantDelta(events: ChatFlowEventEnvelope[]) {
  return events
    .filter((event) => event.type === 'assistant.text.delta')
    .map((event) => String(event.payload.text ?? ''))
    .join('');
}

function nativeExperienceIcon(kind: string) {
  if (kind === 'context') return '▣';
  if (kind === 'search') return '◎';
  if (kind === 'think') return '◉';
  if (kind === 'todo') return '☷';
  if (kind === 'compaction') return '↻';
  return '◇';
}

function isImageAttachment(attachment: Attachment) {
  return attachment.mediaType.startsWith('image/');
}

function MessageImageGallery({
  attachments,
  tenantHeaders,
}: {
  attachments: Attachment[];
  tenantHeaders: Record<string, string>;
}) {
  const images = attachments.filter(isImageAttachment);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Attachment | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all(
      images.map(async (image) => {
        const signed = await readJson<{ url: string }>(
          await fetch(`/api/v1/files/${image.id}/sign`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({ lifetimeSeconds: 900 }),
          }),
        );
        return [image.id, signed.url] as const;
      }),
    )
      .then((entries) => {
        if (active) setUrls(Object.fromEntries(entries));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [attachments, tenantHeaders]);

  if (!images.length) return null;
  return (
    <>
      <div
        className={styles.messageImages}
        data-variant={images.length === 1 ? 'single' : 'tile'}
      >
        {images.map((image) =>
          urls[image.id] ? (
            <button
              key={image.id}
              onClick={() => setPreview(image)}
              title={`查看 ${image.fileName}`}
              type="button"
            >
              <img alt={image.fileName} src={urls[image.id]} />
            </button>
          ) : (
            <span className={styles.imagePlaceholder} key={image.id}>
              正在加载图片…
            </span>
          ),
        )}
      </div>
      {preview && urls[preview.id] ? (
        <DshDialog
          ariaLabel={`预览 ${preview.fileName}`}
          bodyClassName={styles.attachmentPreviewBody}
          className={styles.attachmentPreviewDialog}
          onClose={() => setPreview(null)}
          title={preview.fileName}
        >
          <img alt={preview.fileName} src={urls[preview.id]} />
        </DshDialog>
      ) : null}
    </>
  );
}

function PendingAttachmentRail({
  attachments,
  disabled,
  onOpen,
  onRemove,
  onRetry,
}: {
  attachments: PendingAttachment[];
  disabled: boolean;
  onOpen: (attachment: PendingAttachment) => void;
  onRemove: (attachment: PendingAttachment) => void;
  onRetry: (attachment: PendingAttachment) => void;
}) {
  const rail = useRef<HTMLDivElement | null>(null);
  const previousCount = useRef<number | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const element = rail.current;
    if (!element) return;
    const left = element.scrollLeft > 1;
    const right =
      element.scrollLeft < element.scrollWidth - element.clientWidth - 1;
    setEdges((current) =>
      current.left === left && current.right === right
        ? current
        : { left, right },
    );
  }, []);

  useLayoutEffect(() => {
    const grew =
      previousCount.current !== null &&
      attachments.length > previousCount.current;
    previousCount.current = attachments.length;
    const element = rail.current;
    if (!element) return;
    if (grew) element.scrollLeft = element.scrollWidth - element.clientWidth;
    updateEdges();
  }, [attachments.length, updateEdges]);

  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updateEdges);
    observer?.observe(element);
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0) return;
      const scale =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientWidth
            : 1;
      event.preventDefault();
      element.scrollBy({
        left:
          event.deltaX !== 0
            ? event.deltaX * scale
            : Math.sign(event.deltaY) *
              Math.min(Math.abs(event.deltaY) * scale, 60),
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      observer?.disconnect();
      element.removeEventListener('wheel', onWheel);
    };
  }, [updateEdges]);

  const page = (direction: -1 | 1) => {
    const element = rail.current;
    if (!element) return;
    element.scrollBy({
      left: direction * Math.max(element.clientWidth - 64, 200),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  };

  return (
    <div className={styles.pendingFiles}>
      {edges.left ? (
        <button
          aria-label="向左查看附件"
          className={`${styles.pendingFileArrow} ${styles.pendingFileArrowLeft}`}
          onClick={() => page(-1)}
          type="button"
        >
          ‹
        </button>
      ) : null}
      <div
        aria-label="待发送附件"
        className={styles.pendingFileRail}
        onScroll={updateEdges}
        ref={rail}
        role="group"
      >
        {attachments.map((attachment) => (
          <div className={styles.pendingFileItem} key={attachment.id}>
            {attachment.previewUrl ? (
              <button
                className={styles.pendingFileThumbnail}
                disabled={disabled}
                onClick={() => onOpen(attachment)}
                title={`查看 ${attachment.fileName}`}
                type="button"
              >
                <img alt={attachment.fileName} src={attachment.previewUrl} />
              </button>
            ) : (
              <div
                className={styles.pendingDocument}
                title={attachment.fileName}
              >
                <b aria-hidden="true">▧</b>
                <span>{attachment.fileName}</span>
              </div>
            )}
            {attachment.status === 'uploading' ? (
              <span className={styles.pendingFileState}>上传中</span>
            ) : null}
            {attachment.status === 'failed' ? (
              <button
                className={styles.pendingFileRetry}
                disabled={disabled}
                onClick={() => onRetry(attachment)}
                title={attachment.error ?? '上传失败'}
                type="button"
              >
                重试
              </button>
            ) : null}
            <button
              aria-label={`移除 ${attachment.fileName}`}
              className={styles.pendingFileRemove}
              disabled={disabled}
              onClick={() => onRemove(attachment)}
              type="button"
            >
              <svg aria-hidden="true" viewBox="0 0 12 12">
                <path d="M3 3l6 6M9 3 3 9" />
              </svg>
            </button>
          </div>
        ))}
      </div>
      {edges.right ? (
        <button
          aria-label="向右查看附件"
          className={`${styles.pendingFileArrow} ${styles.pendingFileArrowRight}`}
          onClick={() => page(1)}
          type="button"
        >
          ›
        </button>
      ) : null}
    </div>
  );
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return;

  textarea.style.height = 'auto';
  const configuredMaxHeight = Number.parseFloat(
    window.getComputedStyle(textarea).maxHeight,
  );
  const maxHeight = Number.isFinite(configuredMaxHeight)
    ? configuredMaxHeight
    : 336;
  const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY =
    textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
}

export function ChatFlowClient() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [manifest, setManifest] = useState<SaasCapabilityManifest | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runViews, setRunViews] = useState<Record<string, RunView>>({});
  const [runTraces, setRunTraces] = useState<Record<string, RunTrace>>({});
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [attachmentPreview, setAttachmentPreview] =
    useState<PendingAttachment | null>(null);
  const [uploadVisibility, setUploadVisibility] =
    useState<Visibility>('private');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [employeeDetailsOpen, setEmployeeDetailsOpen] = useState(false);
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgeDevices, setBridgeDevices] = useState<BridgeDevice[]>([]);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeRecoveryActive, setBridgeRecoveryActive] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [atTranscriptBottom, setAtTranscriptBottom] = useState(true);
  const activeStreams = useRef(new Map<string, AbortController>());
  const runEventBuffers = useRef(new Map<string, ChatFlowEventEnvelope[]>());
  const terminalRunIds = useRef(new Set<string>());
  const loadedTraceIds = useRef(new Set<string>());
  const traceLoads = useRef(new Set<string>());
  const conversationScroll = useRef<HTMLDivElement | null>(null);
  const transcriptColumn = useRef<HTMLDivElement | null>(null);
  const followTranscript = useRef(true);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const dragDepth = useRef(0);
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

  const scrollToTranscriptBottom = useCallback(() => {
    const scrollRegion = conversationScroll.current;
    if (!scrollRegion) return;
    scrollRegion.scrollTop = scrollRegion.scrollHeight;
    followTranscript.current = true;
    setAtTranscriptBottom(true);
  }, []);

  const resetRunState = useCallback(() => {
    for (const controller of activeStreams.current.values()) {
      controller.abort();
    }
    activeStreams.current.clear();
    runEventBuffers.current.clear();
    terminalRunIds.current.clear();
    loadedTraceIds.current.clear();
    traceLoads.current.clear();
    setRunViews({});
    setRunTraces({});
  }, []);

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

  const tenantOrganizationId = workspace?.organizationId;
  const tenantWorkspaceId = workspace?.workspaceId;
  const tenantHeaders = useMemo<Record<string, string>>(
    () =>
      tenantOrganizationId && tenantWorkspaceId
        ? {
            'x-allrice-organization-id': tenantOrganizationId,
            'x-allrice-workspace-id': tenantWorkspaceId,
          }
        : ({} as Record<string, string>),
    [tenantOrganizationId, tenantWorkspaceId],
  );

  const loadWorkspace = useCallback(async () => {
    const [workspaceResult, capabilityResult] = await Promise.all([
      readJson<{ workspace: Workspace }>(
        await fetch('/api/v1/workspace', { cache: 'no-store' }),
      ),
      readJson<{ capabilities: SaasCapabilityManifest }>(
        await fetch('/api/v1/saas/capabilities', { cache: 'no-store' }),
      ),
    ]);
    setWorkspace(workspaceResult.workspace);
    setManifest(capabilityResult.capabilities);
    setActiveId((current) => {
      if (
        current &&
        workspaceResult.workspace.sessions.some(
          (session) => session.id === current && !session.archivedAt,
        )
      ) {
        return current;
      }
      return (
        workspaceResult.workspace.sessions.find(
          (session) => !session.archivedAt,
        )?.id ?? null
      );
    });
  }, []);

  const loadHistory = useCallback(
    async (sessionId: string) => {
      if (!tenantWorkspaceId) return;
      const result = await readJson<{ history: History }>(
        await fetch(
          `/api/v1/sessions/${sessionId}?workspaceId=${tenantWorkspaceId}`,
          { cache: 'no-store', headers: tenantHeaders },
        ),
      );
      setHistory(result.history);
    },
    [tenantHeaders, tenantWorkspaceId],
  );

  const streamRun = useCallback(
    async (runId: string) => {
      if (
        !workspace ||
        activeStreams.current.has(runId) ||
        terminalRunIds.current.has(runId)
      )
        return;
      const controller = new AbortController();
      activeStreams.current.set(runId, controller);
      let accumulated = runEventBuffers.current.get(runId) ?? [];
      let cursor: string | null = accumulated.at(-1)?.cursor ?? null;
      let reconnects = 0;
      let terminal = false;
      setRunViews((current) => ({
        ...current,
        [runId]: {
          runId,
          status: 'connecting',
          cursor,
          reconnects: 0,
          events: mergeChatFlowEvents(
            current[runId]?.events ?? [],
            accumulated,
          ),
        },
      }));
      while (!terminal && reconnects <= 6 && !controller.signal.aborted) {
        try {
          const headers: Record<string, string> = { ...tenantHeaders };
          if (cursor) headers['last-event-id'] = cursor;
          const response = await fetch(
            `/api/v1/runs/${runId}/events?workspaceId=${workspace.workspaceId}`,
            { cache: 'no-store', headers, signal: controller.signal },
          );
          if (!response.ok || !response.body) await readJson(response);
          const reader = response.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          setRunViews((current) => ({
            ...current,
            [runId]: {
              ...(current[runId] ?? {
                runId,
                cursor,
                reconnects,
                events: accumulated,
              }),
              status: 'running',
            },
          }));
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() ?? '';
            for (const block of blocks) {
              const data = block
                .split('\n')
                .filter((line) => line.startsWith('data: '))
                .map((line) => line.slice(6))
                .join('\n');
              if (!data) continue;
              const event = JSON.parse(data) as ChatFlowEventEnvelope;
              cursor = event.cursor;
              accumulated = mergeChatFlowEvents(accumulated, [event]);
              runEventBuffers.current.set(runId, accumulated);
              terminal = [
                'run.succeeded',
                'run.failed',
                'run.canceled',
                'run.needs_attention',
              ].includes(event.type);
              setRunViews((current) => ({
                ...current,
                [runId]: {
                  runId,
                  status:
                    event.type === 'run.failed'
                      ? 'failed'
                      : event.type === 'run.canceled'
                        ? 'canceled'
                        : terminal
                          ? 'completed'
                          : 'running',
                  cursor,
                  reconnects,
                  events: mergeChatFlowEvents(
                    current[runId]?.events ?? [],
                    accumulated,
                  ),
                },
              }));
            }
          }
          if (!terminal) {
            reconnects += 1;
            setRunViews((current) => ({
              ...current,
              [runId]: current[runId]
                ? { ...current[runId], reconnects }
                : {
                    runId,
                    status: 'connecting',
                    cursor,
                    reconnects,
                    events: accumulated,
                  },
            }));
          }
        } catch (cause) {
          if (controller.signal.aborted) break;
          reconnects += 1;
          setRunViews((current) => ({
            ...current,
            [runId]: current[runId]
              ? { ...current[runId], status: 'connecting', reconnects }
              : {
                  runId,
                  status: 'connecting',
                  cursor,
                  reconnects,
                  events: accumulated,
                },
          }));
          if (reconnects > 6) {
            setError(
              cause instanceof Error
                ? `实时连接恢复失败：${cause.message}`
                : '实时连接恢复失败',
            );
            break;
          }
        }
        if (!terminal && reconnects <= 6) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, Math.min(300 * 2 ** reconnects, 3_000)),
          );
        }
      }
      if (activeStreams.current.get(runId) === controller) {
        activeStreams.current.delete(runId);
      }
      if (controller.signal.aborted) return;
      if (terminal) {
        terminalRunIds.current.add(runId);
        loadedTraceIds.current.add(runId);
        setRunTraces((current) => ({
          ...current,
          [runId]: {
            status: 'loaded',
            events: mergeChatFlowEvents(
              current[runId]?.events ?? [],
              accumulated,
            ),
          },
        }));
      }
      if (activeId) await loadHistory(activeId).catch(() => undefined);
      await loadWorkspace().catch(() => undefined);
    },
    [activeId, loadHistory, loadWorkspace, tenantHeaders, workspace],
  );

  const loadRunTrace = useCallback(
    async (runId: string) => {
      if (
        !workspace ||
        loadedTraceIds.current.has(runId) ||
        traceLoads.current.has(runId)
      )
        return;
      traceLoads.current.add(runId);
      setRunTraces((current) => ({
        ...current,
        [runId]: { status: 'loading', events: current[runId]?.events ?? [] },
      }));
      try {
        const result = await readJson<{ events: ChatFlowEventEnvelope[] }>(
          await fetch(
            `/api/v1/runs/${runId}/events?workspaceId=${workspace.workspaceId}&format=json`,
            {
              cache: 'no-store',
              headers: { ...tenantHeaders, accept: 'application/json' },
            },
          ),
        );
        loadedTraceIds.current.add(runId);
        setRunTraces((current) => ({
          ...current,
          [runId]: {
            status: 'loaded',
            events: mergeChatFlowEvents(
              current[runId]?.events ?? [],
              result.events,
            ),
          },
        }));
      } catch {
        setRunTraces((current) => ({
          ...current,
          [runId]: { status: 'failed', events: [] },
        }));
      } finally {
        traceLoads.current.delete(runId);
      }
    },
    [tenantHeaders, workspace],
  );

  useEffect(() => {
    loadWorkspace().catch((cause) =>
      setError(cause instanceof Error ? cause.message : '工作区加载失败'),
    );
  }, [loadWorkspace]);

  useEffect(() => {
    if (!activeId) {
      resetRunState();
      setHistory(null);
      return;
    }
    followTranscript.current = true;
    setAtTranscriptBottom(true);
    resetRunState();
    loadHistory(activeId).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '会话加载失败'),
    );
  }, [activeId, loadHistory, resetRunState]);

  useEffect(() => {
    const pendingRunIds = (history?.messages ?? [])
      .filter((message) => message.status === 'pending' && message.runId)
      .map((message) => message.runId as string);
    for (const runId of pendingRunIds) {
      void streamRun(runId);
    }
  }, [history, streamRun]);

  useEffect(() => {
    const historicalRunIds = (history?.messages ?? [])
      .filter((message) => message.status !== 'pending')
      .map((message) => message.runId)
      .filter((value): value is string => Boolean(value));
    for (const runId of historicalRunIds) {
      void loadRunTrace(runId);
    }
  }, [history, loadRunTrace]);

  useEffect(() => {
    const scrollRegion = conversationScroll.current;
    if (!scrollRegion) return;
    const handleScroll = () => {
      const atBottom = isConversationAtBottom(scrollRegion);
      followTranscript.current = atBottom;
      setAtTranscriptBottom(atBottom);
    };
    scrollRegion.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => scrollRegion.removeEventListener('scroll', handleScroll);
  }, [activeId, history?.messages.length]);

  useLayoutEffect(() => {
    if (followTranscript.current) scrollToTranscriptBottom();
  }, [history, runViews, scrollToTranscriptBottom]);

  useLayoutEffect(() => {
    resizeComposerTextarea(composerInput.current);
  }, [activeId, draft, history?.messages.length, sidebarCollapsed, workspace]);

  useEffect(() => {
    const textarea = composerInput.current;
    if (!textarea || typeof ResizeObserver === 'undefined') return;

    let previousWidth = textarea.clientWidth;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.clientWidth;
      if (nextWidth === previousWidth) return;
      previousWidth = nextWidth;
      resizeComposerTextarea(textarea);
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [activeId, history?.messages.length, workspace]);

  useEffect(() => {
    const column = transcriptColumn.current;
    const scrollRegion = conversationScroll.current;
    if (!column || !scrollRegion || typeof ResizeObserver === 'undefined') {
      return;
    }
    const composer = scrollRegion.querySelector<HTMLElement>(
      '[data-composer-seat]',
    );
    const observer = new ResizeObserver(() => {
      if (followTranscript.current) scrollToTranscriptBottom();
    });
    observer.observe(column);
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [activeId, history?.messages.length, scrollToTranscriptBottom]);

  useEffect(
    () => () => {
      for (const controller of activeStreams.current.values()) {
        controller.abort();
      }
      activeStreams.current.clear();
    },
    [],
  );

  useEffect(() => {
    const mobile = window.matchMedia('(max-width: 760px)');
    const syncSidebar = () => setSidebarCollapsed(mobile.matches);
    syncSidebar();
    mobile.addEventListener('change', syncSidebar);
    return () => mobile.removeEventListener('change', syncSidebar);
  }, []);

  async function createSession() {
    if (!workspace) return null;
    const employee =
      workspace.employees.find((item) => item.isDefault) ??
      workspace.employees[0];
    if (!employee) throw new Error('当前没有可用的 AI 员工');
    const result = await readJson<{ session: Session }>(
      await fetch('/api/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...tenantHeaders },
        body: JSON.stringify({
          workspaceId: workspace.workspaceId,
          employeeAssignmentId: employee.id,
          title: draft.trim().slice(0, 60) || '新的工作',
        }),
      }),
    );
    setWorkspace({
      ...workspace,
      sessions: [result.session, ...workspace.sessions],
    });
    setActiveId(result.session.id);
    setHistory({
      session: result.session,
      messages: [],
      contextStatus: {
        percentage: 0,
        pressureTokens: 0,
        thresholdTokens: 40_000,
        compactionDue: false,
      },
      nativeContextStatus: null,
    });
    return result.session.id;
  }

  async function persistPendingAttachment(
    attachment: PendingAttachment,
    sessionId: string,
  ): Promise<Attachment> {
    if (!workspace) throw new Error('工作区尚未加载');
    if (attachment.persistedId) {
      return {
        id: attachment.persistedId,
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
        sizeBytes: attachment.sizeBytes,
        ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
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
        ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
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
  }

  function uploadAttachments(files: FileList | File[]) {
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
  }

  async function openWorkspaceFiles() {
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
  }

  const loadBridgeDevices = useCallback(
    async (open = false, quiet = false) => {
      if (!workspace) return;
      if (!quiet) setBridgeBusy(true);
      try {
        const result = await readJson<{ devices: BridgeDevice[] }>(
          await fetch(
            `/api/v1/bridge/devices?workspaceId=${workspace.workspaceId}`,
            { cache: 'no-store', headers: tenantHeaders },
          ),
        );
        setBridgeDevices(result.devices);
        if (
          result.devices.some(
            (device) =>
              device.status === 'online' && device.folderGrants.length > 0,
          )
        ) {
          setBridgeRecoveryActive(false);
        }
        if (open) setBridgeOpen(true);
      } catch (cause) {
        if (!quiet) {
          setError(
            cause instanceof Error ? cause.message : '本地电脑状态加载失败',
          );
        }
      } finally {
        if (!quiet) setBridgeBusy(false);
      }
    },
    [tenantHeaders, workspace],
  );

  async function disconnectBridgeWorkspace(device: BridgeDevice) {
    if (!workspace) return;
    setBridgeBusy(true);
    try {
      await Promise.all(
        device.folderGrants.map(async (grant) => {
          await readJson(
            await fetch(
              `/api/v1/bridge/grants/${grant.id}?workspaceId=${workspace.workspaceId}`,
              { method: 'DELETE', headers: tenantHeaders },
            ),
          ).catch((cause) => {
            if (cause instanceof SyntaxError) return null;
            throw cause;
          });
        }),
      );
      setBridgeRecoveryActive(false);
      await loadBridgeDevices();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工作区断开失败');
    } finally {
      setBridgeBusy(false);
    }
  }

  async function requestBridgeWorkspaceSelection(device: BridgeDevice) {
    if (!workspace) return;
    setBridgeBusy(true);
    setBridgeRecoveryActive(true);
    try {
      await readJson(
        await fetch(
          `/api/v1/bridge/devices/${device.id}/workspace-selection?workspaceId=${workspace.workspaceId}`,
          { method: 'POST', headers: tenantHeaders },
        ),
      );
    } catch (cause) {
      setBridgeRecoveryActive(false);
      setError(
        cause instanceof Error ? cause.message : '无法打开本地文件夹选择器',
      );
    } finally {
      setBridgeBusy(false);
    }
  }

  async function downloadBridgeClient() {
    setBridgeBusy(true);
    try {
      const response = await fetch('/api/v1/bridge/client/macos-arm64', {
        headers: tenantHeaders,
      });
      if (!response.ok) await readJson(response);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'RiceBridge-v0.2.zip';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'RiceBridge 下载失败');
    } finally {
      setBridgeBusy(false);
    }
  }

  useEffect(() => {
    if (!workspace) {
      setBridgeDevices([]);
      return;
    }
    void loadBridgeDevices(false, true);
    const timer = window.setInterval(() => {
      void loadBridgeDevices(false, true);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadBridgeDevices, workspace]);

  useEffect(() => {
    if (!bridgeRecoveryActive || !workspace) return;
    const timer = window.setInterval(() => {
      void loadBridgeDevices(false, true);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [bridgeRecoveryActive, loadBridgeDevices, workspace]);

  async function addWorkspaceFile(file: WorkspaceFile) {
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
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!workspace || !text || busy) return;
    const draftAttachments = [...pendingAttachments];
    const clientMessageId = crypto.randomUUID();
    const optimisticUserId = `optimistic-user:${clientMessageId}`;
    const optimisticAssistantId = `optimistic-assistant:${clientMessageId}`;
    followTranscript.current = true;
    setAtTranscriptBottom(true);
    setBusy(true);
    setError('');
    try {
      const sessionId = activeId ?? (await createSession());
      if (!sessionId) return;
      const uploadResults = await Promise.allSettled(
        draftAttachments.map((attachment) =>
          persistPendingAttachment(attachment, sessionId),
        ),
      );
      const failedUpload = uploadResults.find(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );
      if (failedUpload) {
        throw failedUpload.reason instanceof Error
          ? failedUpload.reason
          : new Error('文件上传失败');
      }
      const messageAttachments = uploadResults.map(
        (result) => (result as PromiseFulfilledResult<Attachment>).value,
      );
      setDraft('');
      const createdAt = new Date().toISOString();
      setHistory((current) =>
        current && current.session.id === sessionId
          ? {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: optimisticUserId,
                  role: 'user',
                  content: { text },
                  status: 'completed',
                  runId: null,
                  createdAt,
                  attachments: messageAttachments,
                },
                {
                  id: optimisticAssistantId,
                  role: 'assistant',
                  content: { text: 'Rice 正在处理…' },
                  status: 'pending',
                  runId: null,
                  createdAt,
                },
              ],
            }
          : current,
      );
      const result = await readJson<{
        run: { id: string };
        fallbackRunId: string | null;
        delivery: 'immediate' | 'steer_pending' | 'follow_up';
        userMessage: Message;
        assistantMessage: Message;
      }>(
        await fetch(
          `/api/v1/sessions/${sessionId}/messages?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({
              clientMessageId,
              text,
              attachmentIds: messageAttachments.map((item) => item.id),
              deliveryMode: 'auto',
            }),
          },
        ),
      );
      clearPendingAttachments();
      const assistantRunId =
        result.delivery === 'immediate' ? result.run.id : result.fallbackRunId;
      setHistory((current) =>
        current && current.session.id === sessionId
          ? {
              ...current,
              messages: current.messages.map((message) =>
                message.id === optimisticUserId
                  ? result.userMessage
                  : message.id === optimisticAssistantId
                    ? {
                        ...result.assistantMessage,
                        runId: assistantRunId,
                      }
                    : message,
              ),
            }
          : current,
      );
      void streamRun(result.run.id);
      void loadHistory(sessionId);
    } catch (cause) {
      setHistory((current) =>
        current
          ? {
              ...current,
              messages: current.messages.filter(
                (message) =>
                  message.id !== optimisticUserId &&
                  message.id !== optimisticAssistantId,
              ),
            }
          : current,
      );
      setDraft(text);
      setError(cause instanceof Error ? cause.message : '消息发送失败');
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun() {
    const targetRun = [...(history?.messages ?? [])]
      .reverse()
      .map((message) => (message.runId ? runViews[message.runId] : undefined))
      .find(
        (view) => view?.status === 'running' || view?.status === 'connecting',
      );
    if (!workspace || !targetRun) return;
    await readJson(
      await fetch(
        `/api/v1/runs/${targetRun.runId}/cancel?workspaceId=${workspace.workspaceId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({ reason: 'user_requested' }),
        },
      ),
    ).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '停止失败'),
    );
  }

  if (!workspace || !manifest) {
    return <main className={styles.loading}>正在进入 AllRice ChatFlow…</main>;
  }

  const sessions = workspace.sessions.filter((session) => !session.archivedAt);
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeEmployee = activeSession
    ? employeeForSession(workspace, activeSession)
    : (workspace.employees.find((employee) => employee.isDefault) ??
      workspace.employees[0]);
  const activeEmployeeProfile = workspace.employeeProfiles.find(
    (profile) => profile.assignmentId === activeEmployee?.id,
  );
  const isRunning = Object.values(runViews).some(
    (view) => view.status === 'running' || view.status === 'connecting',
  );
  const isEmptyConversation =
    !history?.messages.length && Object.keys(runViews).length === 0;
  const recoverableRunView = [...(history?.messages ?? [])]
    .reverse()
    .map((message) => (message.runId ? runViews[message.runId] : undefined))
    .find((view) => view?.status === 'failed' || view?.status === 'canceled');
  const selectedBridgeDevice = bridgeDevices.find(
    (device) => device.status !== 'revoked' && device.folderGrants.length > 0,
  );
  const onlineBridgeDevice = bridgeDevices.find(
    (device) => device.status === 'online',
  );
  const localWorkspaceOnline = selectedBridgeDevice?.status === 'online';
  const localWorkspaceLabel = selectedBridgeDevice?.folderGrants[0]?.label;

  const renderComposer = (hero = false) => (
    <div className={`${inputUi.root} ${hero ? inputUi.hero : ''}`}>
      {error ? <div className={inputUi.notice}>{error}</div> : null}
      <div className={inputUi.card}>
        {pendingAttachments.length ? (
          <PendingAttachmentRail
            attachments={pendingAttachments}
            disabled={busy}
            onOpen={setAttachmentPreview}
            onRemove={removePendingAttachment}
            onRetry={(target) => {
              setPendingAttachments((current) =>
                current.map((attachment) =>
                  attachment.id === target.id
                    ? { ...attachment, status: 'draft', error: undefined }
                    : attachment,
                ),
              );
              setError('');
            }}
          />
        ) : null}
        <textarea
          aria-label="给 Rice 的消息"
          className={styles.composerInput}
          disabled={busy}
          onChange={(event) => {
            setDraft(event.target.value);
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
            void sendMessage();
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith('image/'),
            );
            if (!files.length) return;
            event.preventDefault();
            uploadAttachments(files);
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
                onClick={() => setAttachmentMenuOpen((open) => !open)}
                type="button"
              >
                ＋
              </button>
              {attachmentMenuOpen ? (
                <div className={styles.attachmentMenu} role="menu">
                  <button
                    onClick={() => {
                      setAttachmentMenuOpen(false);
                      void openWorkspaceFiles();
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
                      setAttachmentMenuOpen(false);
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
                    uploadAttachments(event.target.files);
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
                setUploadVisibility(event.target.value as Visibility)
              }
              value={uploadVisibility}
            >
              <option value="private">保持私有</option>
              <option value="workspace">工作区公开</option>
            </select>
          </div>
          <div className={inputUi.trailing}>
            <span className={styles.providerChip}>
              {providerForSession(workspace, activeSession)}
            </span>
            <button
              aria-label="发送"
              className={inputUi.primary}
              disabled={busy || !draft.trim()}
              onClick={() => void sendMessage()}
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
            onClick={() => void loadBridgeDevices(true)}
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
          {history?.nativeContextStatus ? (
            <span
              title={`DSH 原生上下文投影：约 ${history.nativeContextStatus.usedTokens.toLocaleString()} / ${history.nativeContextStatus.contextWindowTokens.toLocaleString()} tokens`}
            >
              Session 上下文 {history.nativeContextStatus.percentage}%
            </span>
          ) : null}
        </div>
        {isRunning ? (
          <button onClick={() => void cancelRun()} type="button">
            停止本轮
          </button>
        ) : null}
      </div>
    </div>
  );

  return (
    <main
      className={`${frameUi.frame} ${styles.shell}`}
      data-details-collapsed="true"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          dragDepth.current += 1;
          setImageDragActive(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setImageDragActive(false);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setImageDragActive(false);
        if (!busy) uploadAttachments(event.dataTransfer.files);
      }}
      style={{
        gridTemplateColumns: sidebarCollapsed
          ? '57px minmax(0, 1fr)'
          : '280px minmax(0, 1fr)',
      }}
    >
      {imageDragActive ? (
        <div className={styles.imageDropOverlay}>
          <div>
            <strong>
              {busy ? '当前无法添加图片' : '图片拖动到此处即可添加'}
            </strong>
            {!busy ? <span>最多 20 张，每张 20 MB</span> : null}
          </div>
        </div>
      ) : null}
      <aside className={frameUi.sidebarCol}>
        <div
          className={`${sidebarUi.root} ${
            sidebarCollapsed ? sidebarUi.collapsed : styles.sidebar
          }`}
        >
          <div className={sidebarUi.logoRow}>
            {!sidebarCollapsed ? (
              <button
                aria-label="开始新的工作"
                className={sidebarUi.brand}
                onClick={() => {
                  resetRunState();
                  setActiveId(null);
                  setHistory(null);
                  setDraft('');
                  clearPendingAttachments();
                }}
                type="button"
              >
                <span className={sidebarUi.brandIdentity}>
                  <span className={styles.allRiceMark}>R</span>
                  <span
                    className={`${sidebarUi.brandName} ${sidebarUi.fallbackBrandName}`}
                  >
                    AllRice
                  </span>
                </span>
              </button>
            ) : null}
            <button
              aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              className={`${sidebarUi.iconButton} ${sidebarUi.toggle}`}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              type="button"
            >
              {sidebarCollapsed ? (
                <>
                  <span className={`${sidebarUi.railMark} ${styles.railMark}`}>
                    R
                  </span>
                  <span
                    aria-hidden="true"
                    className={`${sidebarUi.panelIcon} ${styles.sidebarToggle}`}
                  >
                    ›
                  </span>
                </>
              ) : (
                <span aria-hidden="true" className={styles.sidebarToggle}>
                  ‹
                </span>
              )}
            </button>
          </div>

          <button
            className={sidebarUi.newSession}
            onClick={() => {
              resetRunState();
              setActiveId(null);
              setHistory(null);
              setDraft('');
              clearPendingAttachments();
            }}
            type="button"
          >
            <span aria-hidden="true">＋</span>
            <span className={sidebarUi.newSessionLabel}>新的工作</span>
          </button>

          <div className={sidebarUi.regionArea}>
            {sidebarCollapsed ? (
              <nav aria-label="最近对话" className={styles.railSessions}>
                {sessions.slice(0, 12).map((session) => (
                  <button
                    aria-label={session.title}
                    className={
                      session.id === activeId ? styles.activeRailSession : ''
                    }
                    key={session.id}
                    onClick={() => {
                      if (session.id !== activeId) clearPendingAttachments();
                      setActiveId(session.id);
                    }}
                    title={session.title}
                    type="button"
                  >
                    {session.title.trim().slice(0, 1).toUpperCase() || 'R'}
                  </button>
                ))}
              </nav>
            ) : (
              <section className={styles.sessionSection}>
                <p>最近对话</p>
                <nav>
                  {sessions.map((session) => (
                    <button
                      className={
                        session.id === activeId ? styles.activeSession : ''
                      }
                      key={session.id}
                      onClick={() => {
                        if (session.id !== activeId) clearPendingAttachments();
                        setActiveId(session.id);
                      }}
                      type="button"
                    >
                      <span>{session.title}</span>
                      <small>
                        {providerForSession(workspace, session)} ·{' '}
                        {formatTime(session.updatedAt)}
                      </small>
                    </button>
                  ))}
                  {sessions.length === 0 ? (
                    <span className={styles.emptySessions}>还没有对话</span>
                  ) : null}
                </nav>
              </section>
            )}
          </div>

          <div className={sidebarUi.footArea}>
            {!sidebarCollapsed ? (
              <>
                <nav className={styles.saasNavigation}>
                  {manifest.surfaces.includes('platform_admin') ? (
                    <Link href="/runtime-console?view=governance">
                      <span aria-hidden="true">⚙</span>
                      平台管理
                    </Link>
                  ) : null}
                </nav>
                <div className={styles.accountRow}>
                  <span className={styles.accountAvatar}>R</span>
                  <span>
                    <strong>
                      {activeEmployee?.currentVersion.manifest.name ?? 'Rice'}
                    </strong>
                    <small>{manifest.roles.join(' · ')}</small>
                  </span>
                  <button
                    aria-label={`查看${activeEmployeeProfile?.name ?? 'Rice'}详情`}
                    className={styles.employeeDetailsButton}
                    disabled={!activeEmployeeProfile}
                    onClick={() => setEmployeeDetailsOpen(true)}
                    title="查看员工详情"
                    type="button"
                  >
                    ›
                  </button>
                </div>
              </>
            ) : (
              <button
                aria-label="查看 Rice 详情"
                className={`${styles.accountAvatar} ${styles.collapsedEmployeeButton}`}
                disabled={!activeEmployeeProfile}
                onClick={() => setEmployeeDetailsOpen(true)}
                title="查看 Rice 详情"
                type="button"
              >
                R
              </button>
            )}
          </div>
        </div>
      </aside>

      <section className={frameUi.centerCol}>
        <div
          className={conversationUi.root}
          data-phase={isEmptyConversation ? 'hero' : 'active'}
        >
          {isEmptyConversation ? (
            <header
              className={`${conversationUi.header} ${conversationUi.headerHidden}`}
            />
          ) : (
            <header
              className={`${conversationUi.header} ${styles.conversationHeader}`}
            >
              <div className={conversationUi.titleRow}>
                <div className={conversationUi.titleCluster}>
                  <div className={conversationUi.crumbs}>
                    <span className={conversationUi.crumbSeg}>
                      <button
                        className={conversationUi.crumb}
                        onClick={() => {
                          resetRunState();
                          setActiveId(null);
                          setHistory(null);
                        }}
                        type="button"
                      >
                        与 Rice 工作
                      </button>
                      <span className={conversationUi.crumbSep}>/</span>
                    </span>
                    <h1>{activeSession?.title ?? '新的工作'}</h1>
                  </div>
                </div>
                <div className={conversationUi.headerActions}>
                  <span className={styles.runtimePill}>
                    <i />
                    {providerForSession(workspace, activeSession)}
                  </span>
                </div>
              </div>
            </header>
          )}

          {isEmptyConversation ? (
            <div className={conversationUi.scrollBody}>
              <section className={styles.emptyStage}>
                <div className={styles.heroStack}>
                  <div className={styles.heroHeadline}>
                    <span className={styles.heroMark}>R</span>
                    <h1>与 Rice 工作</h1>
                    <p>把目标交给 Rice，过程和结果会留在同一个 Session 里。</p>
                  </div>
                  {renderComposer(true)}
                </div>
              </section>
            </div>
          ) : (
            <div
              className={`${conversationUi.scrollBody} ${styles.conversationBody}`}
              data-conversation-scroll
              ref={conversationScroll}
            >
              <div className={conversationUi.viewArea}>
                <div className={chatUi.root}>
                  <div className={chatUi.scroll} data-chat-scroll>
                    <div className={chatUi.column} ref={transcriptColumn}>
                      {history?.messages.map((message) => {
                        const messageRun = message.runId
                          ? (runViews[message.runId] ?? null)
                          : null;
                        const trace = message.runId
                          ? runTraces[message.runId]
                          : undefined;
                        const traceEvents =
                          messageRun?.events ?? trace?.events ?? [];
                        const nativeExperience =
                          projectNativeExperience(traceEvents);
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
                                        onClick={() =>
                                          void loadRunTrace(message.runId!)
                                        }
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
                                {messageIsRunning && !streamedText ? (
                                  <div className={chatUi.turnStatus}>
                                    Rice 正在理解你的需求…
                                  </div>
                                ) : (
                                  <div
                                    className={`${assistantUi.body} ${styles.assistantCopy}`}
                                  >
                                    <AssistantMarkdown
                                      text={
                                        streamedText || message.content.text
                                      }
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
                          onClick={() => {
                            terminalRunIds.current.delete(
                              recoverableRunView.runId,
                            );
                            void streamRun(recoverableRunView.runId);
                          }}
                          type="button"
                        >
                          重新连接并恢复执行记录
                        </button>
                      ) : null}
                    </div>
                    {!atTranscriptBottom ? (
                      <div className={chatUi.toBottomSlot}>
                        <button
                          aria-label="回到底部"
                          className={chatUi.toBottom}
                          onClick={scrollToTranscriptBottom}
                          title="回到底部"
                          type="button"
                        >
                          ↓
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              <div
                className={`${conversationUi.composerSeat} ${styles.composerDock}`}
                data-composer-seat
              >
                {renderComposer(false)}
              </div>
            </div>
          )}
        </div>
      </section>

      {attachmentPreview?.previewUrl ? (
        <DshDialog
          ariaLabel={`预览 ${attachmentPreview.fileName}`}
          bodyClassName={styles.attachmentPreviewBody}
          className={styles.attachmentPreviewDialog}
          onClose={() => setAttachmentPreview(null)}
          title={attachmentPreview.fileName}
        >
          <img
            alt={attachmentPreview.fileName}
            src={attachmentPreview.previewUrl}
          />
        </DshDialog>
      ) : null}

      {employeeDetailsOpen && activeEmployeeProfile ? (
        <DshDialog
          ariaLabel={`${activeEmployeeProfile.name}员工详情`}
          bodyClassName={styles.employeeDetailsBody}
          className={styles.employeeDetailsDialog}
          eyebrow="AI 员工 · 租户只读"
          onClose={() => setEmployeeDetailsOpen(false)}
          title={activeEmployeeProfile.name}
        >
          <div className={styles.employeeProfileIntro}>
            <span className={styles.employeeProfileAvatar}>
              {activeEmployeeProfile.name.slice(0, 1)}
            </span>
            <div>
              <strong>{activeEmployeeProfile.identity.role}</strong>
              <p>{activeEmployeeProfile.description}</p>
            </div>
            <small>由 AllRice 管理员配置</small>
          </div>

          <section className={styles.employeeProfileSection}>
            <header>
              <span>人设</span>
              <small>Rice 如何理解和完成工作</small>
            </header>
            <dl className={styles.employeePersonaGrid}>
              <div>
                <dt>使命</dt>
                <dd>{activeEmployeeProfile.identity.mission}</dd>
              </div>
              <div>
                <dt>工作方式</dt>
                <dd>{activeEmployeeProfile.identity.workStyle}</dd>
              </div>
            </dl>
            {activeEmployeeProfile.identity.behaviorRules.length ? (
              <div className={styles.employeeRuleList}>
                <strong>行为准则</strong>
                <ul>
                  {activeEmployeeProfile.identity.behaviorRules.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {activeEmployeeProfile.identity.safetyBoundaries.length ? (
              <div className={styles.employeeRuleList}>
                <strong>工作边界</strong>
                <ul>
                  {activeEmployeeProfile.identity.safetyBoundaries.map(
                    (boundary) => (
                      <li key={boundary}>{boundary}</li>
                    ),
                  )}
                </ul>
              </div>
            ) : null}
          </section>

          <section className={styles.employeeProfileSection}>
            <header>
              <span>技能</span>
              <small>当前发布给本租户的 DSH 原生 Skill</small>
            </header>
            {activeEmployeeProfile.skills.length ? (
              <div className={styles.employeeSkillList}>
                {activeEmployeeProfile.skills.map((skill) => (
                  <article key={skill.id}>
                    <span aria-hidden="true">◇</span>
                    <div>
                      <strong>{skill.name}</strong>
                      <p>{skill.description}</p>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className={styles.employeeEmptyState}>暂未配置专属技能。</p>
            )}
          </section>

          <section className={styles.employeeProfileSection}>
            <header>
              <span>模型</span>
              <small>平台托管，租户不可修改</small>
            </header>
            <dl className={styles.employeeModelGrid}>
              <div>
                <dt>Harness</dt>
                <dd>DSH</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>
                  {providerDisplayName(activeEmployeeProfile.model.provider)}
                </dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{activeEmployeeProfile.model.model}</dd>
              </div>
              <div>
                <dt>推理强度</dt>
                <dd>
                  {reasoningDisplayName(
                    activeEmployeeProfile.model.reasoningEffort,
                  )}
                </dd>
              </div>
            </dl>
          </section>
        </DshDialog>
      ) : null}

      {filePickerOpen ? (
        <DshDialog
          ariaLabel="从工作区添加文件"
          eyebrow="工作区文件"
          onClose={() => setFilePickerOpen(false)}
          title="选择要交给 Rice 的文件"
        >
          <div className={styles.fileList}>
            {workspaceFiles.map((file) => (
              <button
                key={file.id}
                onClick={() => void addWorkspaceFile(file)}
                type="button"
              >
                <span aria-hidden="true">□</span>
                <div>
                  <strong>{file.fileName}</strong>
                  <small>
                    {file.visibility === 'private' ? '仅自己' : '工作区公开'}
                    {' · '}
                    {Math.max(1, Math.ceil(file.sizeBytes / 1024))} KB
                  </small>
                </div>
                <em>添加</em>
              </button>
            ))}
            {workspaceFiles.length === 0 ? <p>工作区还没有可用文件。</p> : null}
          </div>
        </DshDialog>
      ) : null}

      {bridgeOpen ? (
        <DshDialog
          ariaLabel="本地工作区状态"
          bodyClassName={styles.bridgeBody}
          className={styles.bridgeDialog}
          eyebrow="Rice Bridge v0.2"
          onClose={() => setBridgeOpen(false)}
          title="本地工作区"
        >
          <div className={styles.bridgeIntro}>
            <p>
              Bridge 只读取你明确授权的文件夹，不开放
              Shell，也不会把模型密钥下发到电脑。
            </p>
            <button
              disabled={bridgeBusy}
              onClick={() => void loadBridgeDevices()}
              type="button"
            >
              刷新状态
            </button>
          </div>
          <div className={styles.bridgeDevices}>
            {bridgeDevices.map((device) => (
              <article key={device.id}>
                <span
                  className={
                    device.status === 'online'
                      ? styles.bridgeOnline
                      : styles.bridgeOffline
                  }
                />
                <div>
                  <strong>{device.name}</strong>
                  <small>
                    {device.status === 'online' ? '在线' : '离线'} · Apple
                    Silicon
                  </small>
                  {device.folderGrants.length ? (
                    <small>
                      本地工作区：
                      {device.folderGrants
                        .map((grant) => grant.label)
                        .join('、')}
                    </small>
                  ) : (
                    <small>尚未选择本地工作区</small>
                  )}
                </div>
                {device.folderGrants.length ? (
                  <button
                    disabled={bridgeBusy}
                    onClick={() => void disconnectBridgeWorkspace(device)}
                    type="button"
                  >
                    断开工作区
                  </button>
                ) : null}
              </article>
            ))}
            {!localWorkspaceOnline ? (
              <section className={styles.bridgeRecovery}>
                <div>
                  <strong>
                    {onlineBridgeDevice
                      ? 'Bridge 在线，工作区未连接'
                      : 'Bridge 当前离线'}
                  </strong>
                  {onlineBridgeDevice ? (
                    <p>
                      点击“选择工作区”后，Snow Mac 会立即弹出 macOS
                      文件夹选择器。选择完成后，这里会自动显示文件夹名称。
                    </p>
                  ) : (
                    <p>
                      请先双击 Snow Mac 桌面的
                      RiceBridge，并保持终端窗口开启；Bridge
                      上线后即可从这里选择工作区。
                    </p>
                  )}
                  <button
                    className={styles.bridgeClientDownload}
                    disabled={bridgeBusy}
                    onClick={() => void downloadBridgeClient()}
                    type="button"
                  >
                    下载支持网页唤起的 RiceBridge v0.2
                  </button>
                </div>
                <button
                  className={styles.bridgeRecoveryPrimary}
                  disabled={bridgeBusy || !onlineBridgeDevice}
                  onClick={() => {
                    if (onlineBridgeDevice) {
                      void requestBridgeWorkspaceSelection(onlineBridgeDevice);
                    }
                  }}
                  type="button"
                >
                  {bridgeRecoveryActive
                    ? '等待本地选择…'
                    : onlineBridgeDevice
                      ? '选择工作区'
                      : '等待 Bridge 上线'}
                </button>
                {bridgeRecoveryActive ? (
                  <small>
                    正在等待你在 Snow Mac
                    完成文件夹选择；选择成功后这里会自动显示文件夹名称。
                  </small>
                ) : null}
              </section>
            ) : null}
          </div>
        </DshDialog>
      ) : null}
    </main>
  );
}
