'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  ChatFlowEventEnvelope,
  SaasCapabilityManifest,
} from '@allrice/contracts';

import { shouldSubmitComposerKey } from '../../lib/chatflow/composer-keyboard';
import { projectNativeExperience } from '../../lib/chatflow/native-experience';

import { AssistantMarkdown } from './assistant-markdown';
import assistantUi from './dsh-upstream/AssistantMarkdown.module.css';
import chatUi from './dsh-upstream/ChatView.module.css';
import conversationUi from './dsh-upstream/ConversationRoot.module.css';
import frameUi from './dsh-upstream/AppFrame.module.css';
import inputUi from './dsh-upstream/InputBar.module.css';
import messageUi from './dsh-upstream/MessageItem.module.css';
import sidebarUi from './dsh-upstream/SidebarRoot.module.css';
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

interface Workspace {
  organizationId: string;
  workspaceId: string;
  employees: Employee[];
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
}

interface Attachment {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
}

interface WorkspaceFile extends Attachment {
  visibility: Visibility;
  ownedByMe: boolean;
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
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

function eventsFromSse(text: string) {
  const events: ChatFlowEventEnvelope[] = [];
  for (const block of text.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6))
      .join('\n');
    if (!data) continue;
    const event = JSON.parse(data) as ChatFlowEventEnvelope;
    if (!events.some((item) => item.eventId === event.eventId)) {
      events.push(event);
    }
  }
  return events;
}

export function ChatFlowClient() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [manifest, setManifest] = useState<SaasCapabilityManifest | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runView, setRunView] = useState<RunView | null>(null);
  const [runTraces, setRunTraces] = useState<Record<string, RunTrace>>({});
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>(
    [],
  );
  const [uploadVisibility, setUploadVisibility] =
    useState<Visibility>('private');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const activeStream = useRef<AbortController | null>(null);
  const traceLoads = useRef(new Set<string>());
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const composing = useRef(false);

  const tenantHeaders = useMemo<Record<string, string>>(
    () =>
      workspace
        ? {
            'x-allrice-organization-id': workspace.organizationId,
            'x-allrice-workspace-id': workspace.workspaceId,
          }
        : ({} as Record<string, string>),
    [workspace],
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
      if (!workspace) return;
      const result = await readJson<{ history: History }>(
        await fetch(
          `/api/v1/sessions/${sessionId}?workspaceId=${workspace.workspaceId}`,
          { cache: 'no-store', headers: tenantHeaders },
        ),
      );
      setHistory(result.history);
    },
    [tenantHeaders, workspace],
  );

  const streamRun = useCallback(
    async (runId: string) => {
      if (!workspace) return;
      activeStream.current?.abort();
      const controller = new AbortController();
      activeStream.current = controller;
      let cursor: string | null = null;
      let reconnects = 0;
      let terminal = false;
      let accumulated: ChatFlowEventEnvelope[] = [];
      setRunView({
        runId,
        status: 'connecting',
        cursor: null,
        reconnects: 0,
        events: [],
      });
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
          setRunView((current) =>
            current ? { ...current, status: 'running' } : current,
          );
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
              if (!accumulated.some((item) => item.eventId === event.eventId)) {
                accumulated = [...accumulated, event];
              }
              terminal = [
                'run.succeeded',
                'run.failed',
                'run.canceled',
                'run.needs_attention',
              ].includes(event.type);
              setRunView({
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
                events: accumulated,
              });
            }
          }
          if (!terminal) {
            reconnects += 1;
            setRunView((current) =>
              current ? { ...current, reconnects } : current,
            );
          }
        } catch (cause) {
          if (controller.signal.aborted) break;
          reconnects += 1;
          setRunView((current) =>
            current
              ? { ...current, status: 'connecting', reconnects }
              : current,
          );
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
      if (terminal) {
        setRunTraces((current) => ({
          ...current,
          [runId]: { status: 'loaded', events: accumulated },
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
        runTraces[runId]?.status === 'loaded' ||
        traceLoads.current.has(runId)
      )
        return;
      traceLoads.current.add(runId);
      setRunTraces((current) => ({
        ...current,
        [runId]: { status: 'loading', events: current[runId]?.events ?? [] },
      }));
      try {
        const response = await fetch(
          `/api/v1/runs/${runId}/events?workspaceId=${workspace.workspaceId}`,
          { cache: 'no-store', headers: tenantHeaders },
        );
        if (!response.ok) await readJson(response);
        const events = eventsFromSse(await response.text());
        setRunTraces((current) => ({
          ...current,
          [runId]: { status: 'loaded', events },
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
    [runTraces, tenantHeaders, workspace],
  );

  useEffect(() => {
    loadWorkspace().catch((cause) =>
      setError(cause instanceof Error ? cause.message : '工作区加载失败'),
    );
  }, [loadWorkspace]);

  useEffect(() => {
    if (!activeId) {
      setHistory(null);
      return;
    }
    setRunView(null);
    setRunTraces({});
    traceLoads.current.clear();
    loadHistory(activeId).catch((cause) =>
      setError(cause instanceof Error ? cause.message : '会话加载失败'),
    );
  }, [activeId, loadHistory]);

  useEffect(() => {
    const pending = [...(history?.messages ?? [])]
      .reverse()
      .find((message) => message.status === 'pending' && message.runId);
    if (pending?.runId && runView?.runId !== pending.runId) {
      void streamRun(pending.runId);
    }
  }, [history, runView?.runId, streamRun]);

  useEffect(() => {
    const historicalRunIds = (history?.messages ?? [])
      .map((message) => message.runId)
      .filter((value): value is string => Boolean(value));
    for (const runId of historicalRunIds) {
      if (runView?.runId === runId) continue;
      void loadRunTrace(runId);
    }
  }, [history, loadRunTrace, runView?.runId]);

  useEffect(() => {
    const scrollRegion =
      transcriptEnd.current?.closest<HTMLElement>('[data-chat-scroll]');
    scrollRegion?.scrollTo({
      behavior: 'smooth',
      top: scrollRegion.scrollHeight,
    });
  }, [history, runView]);

  useEffect(
    () => () => {
      activeStream.current?.abort();
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
    });
    return result.session.id;
  }

  async function uploadAttachment(file: File) {
    if (!workspace) return;
    if (file.size > 8_000_000) {
      setError('附件不能超过 8 MB。');
      return;
    }
    const mediaType =
      file.type ||
      (file.name.endsWith('.md')
        ? 'text/markdown'
        : file.name.endsWith('.txt')
          ? 'text/plain'
          : file.name.endsWith('.json')
            ? 'application/json'
            : '');
    if (!mediaType) {
      setError('不支持这种附件格式。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const sessionId = activeId ?? (await createSession());
      if (!sessionId) return;
      const result = await readJson<{ attachment: Attachment }>(
        await fetch(
          `/api/v1/sessions/${sessionId}/attachments?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({
              fileName: file.name,
              mediaType,
              contentBase64: await fileToBase64(file),
              visibility: uploadVisibility,
            }),
          },
        ),
      );
      setPendingAttachments((current) => [
        ...current.filter((item) => item.id !== result.attachment.id),
        result.attachment,
      ]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '文件上传失败');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
      setBusy(false);
    }
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
        file,
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
    const clientMessageId = crypto.randomUUID();
    const optimisticUserId = `optimistic-user:${clientMessageId}`;
    const optimisticAssistantId = `optimistic-assistant:${clientMessageId}`;
    setBusy(true);
    setError('');
    try {
      const sessionId = activeId ?? (await createSession());
      if (!sessionId) return;
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
              attachmentIds: pendingAttachments.map((item) => item.id),
              deliveryMode: 'auto',
            }),
          },
        ),
      );
      setPendingAttachments([]);
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
    if (!workspace || !runView) return;
    await readJson(
      await fetch(
        `/api/v1/runs/${runView.runId}/cancel?workspaceId=${workspace.workspaceId}`,
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
  const isRunning =
    runView?.status === 'running' || runView?.status === 'connecting';
  const isEmptyConversation = !history?.messages.length && !runView;

  const renderComposer = (hero = false) => (
    <div className={`${inputUi.root} ${hero ? inputUi.hero : ''}`}>
      {error ? <div className={inputUi.notice}>{error}</div> : null}
      <div className={inputUi.card}>
        {pendingAttachments.length ? (
          <div className={styles.pendingFiles}>
            {pendingAttachments.map((file) => (
              <span key={file.id}>
                <b aria-hidden="true">▧</b>
                {file.fileName}
                <button
                  aria-label={`移除 ${file.fileName}`}
                  onClick={() =>
                    setPendingAttachments((current) =>
                      current.filter((item) => item.id !== file.id),
                    )
                  }
                  type="button"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          aria-label="给 Rice 的消息"
          className={styles.composerInput}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
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
          placeholder={
            hero ? '告诉 Rice 你想完成什么工作' : '继续和 Rice 工作…'
          }
          rows={hero ? 3 : 2}
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
                accept=".txt,.md,.json,.pdf,.png,.jpg,.jpeg,.webp"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadAttachment(file);
                }}
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
        <span>
          Session 上下文 {history?.contextStatus.percentage ?? 0}%
          {history?.contextStatus.compactionDue ? ' · 即将自动压缩' : ''}
        </span>
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
      style={{
        gridTemplateColumns: sidebarCollapsed
          ? '57px minmax(0, 1fr)'
          : '280px minmax(0, 1fr)',
      }}
    >
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
                  activeStream.current?.abort();
                  setActiveId(null);
                  setHistory(null);
                  setRunView(null);
                  setDraft('');
                  setPendingAttachments([]);
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
              activeStream.current?.abort();
              setActiveId(null);
              setHistory(null);
              setRunView(null);
              setDraft('');
              setPendingAttachments([]);
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
                    onClick={() => setActiveId(session.id)}
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
                      onClick={() => setActiveId(session.id)}
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
                  <Link href="/chatflow/employees">
                    <span aria-hidden="true">♙</span>
                    {manifest.surfaces.includes('tenant_admin')
                      ? '员工配置'
                      : '可用员工'}
                  </Link>
                  {manifest.surfaces.includes('tenant_admin') ? (
                    <Link href="/chatflow/governance">
                      <span aria-hidden="true">⌁</span>
                      评测与发布
                    </Link>
                  ) : null}
                  {manifest.surfaces.includes('platform_admin') ? (
                    <Link href="/chatflow/admin">
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
                </div>
              </>
            ) : (
              <div className={styles.accountAvatar} title="Rice">
                R
              </div>
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
                          setActiveId(null);
                          setHistory(null);
                          setRunView(null);
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
            >
              <div className={conversationUi.viewArea}>
                <div className={chatUi.root}>
                  <div className={chatUi.scroll} data-chat-scroll>
                    <div className={chatUi.column}>
                      {history?.messages.map((message) => {
                        const messageRun =
                          message.runId && runView?.runId === message.runId
                            ? runView
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

                      {runView?.status === 'failed' ||
                      runView?.status === 'canceled' ? (
                        <button
                          className={styles.recover}
                          onClick={() => void streamRun(runView.runId)}
                          type="button"
                        >
                          重新连接并恢复执行记录
                        </button>
                      ) : null}
                      <div ref={transcriptEnd} />
                    </div>
                  </div>
                </div>
              </div>
              <div
                className={`${conversationUi.composerSeat} ${styles.composerDock}`}
              >
                {renderComposer(false)}
              </div>
            </div>
          )}
        </div>
      </section>

      {filePickerOpen ? (
        <div
          className={styles.filePickerBackdrop}
          onClick={() => setFilePickerOpen(false)}
          role="presentation"
        >
          <section
            aria-label="从工作区添加文件"
            aria-modal="true"
            className={styles.filePicker}
            onClick={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header>
              <div>
                <p>工作区文件</p>
                <h2>选择要交给 Rice 的文件</h2>
              </div>
              <button onClick={() => setFilePickerOpen(false)} type="button">
                ×
              </button>
            </header>
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
              {workspaceFiles.length === 0 ? (
                <p>工作区还没有可用文件。</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
