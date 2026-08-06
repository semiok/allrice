'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Visibility = 'private' | 'workspace' | 'organization';

interface Attachment {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  restricted: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: {
    text: string;
    citations: { type: string; id: string; label: string }[];
  };
  attachments: Attachment[];
  status: 'pending' | 'completed' | 'failed';
  runId: string | null;
  createdAt: string;
}

interface Session {
  id: string;
  title: string;
  visibility: Visibility;
  updatedAt: string;
  archivedAt: string | null;
}

interface WorkspacePayload {
  organizationId: string;
  workspaceId: string;
  employee: { version: { name: string } };
  sessions: Session[];
  canAdminister: boolean;
}

interface HistoryPayload {
  session: Session;
  messages: Message[];
}

interface RunEvent {
  eventId: string;
  runId: string;
  sequence: number;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

interface WorkspaceFile {
  id: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  visibility: Visibility;
  ownedByMe: boolean;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

async function readJson<T>(response: Response): Promise<T> {
  if (response.status === 401) {
    window.location.assign('/login');
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

async function fileToBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

function toolLabel(name: unknown) {
  const labels: Record<string, string> = {
    'workspace.file.list': '查看工作区文件',
    'workspace.file.read': '读取工作区文件',
    'workspace.memory.search': '检索工作区记忆',
    'workspace.session.search': '检索历史对话',
    'web.search': '联网搜索',
    'web.fetch': '读取公开网页',
    mcp_tool_call: '调用受控工具',
    command_execution: '运行时工具',
  };
  return labels[String(name)] ?? String(name || '工具调用');
}

function RunDetails({ events }: { events: RunEvent[] }) {
  const tools = new Map<string, RunEvent>();
  for (const event of events) {
    if (!event.type.startsWith('tool.')) continue;
    const id = String(event.payload.toolCallId ?? event.eventId);
    const previous = tools.get(id);
    if (!previous || event.sequence > previous.sequence) tools.set(id, event);
  }
  const retries = events.filter((event) => event.type === 'run.retrying');
  if (tools.size === 0 && retries.length === 0) return null;
  return (
    <details className="run-details">
      <summary>
        {tools.size ? `${tools.size} 个工具调用` : ''}
        {tools.size && retries.length ? ' · ' : ''}
        {retries.length ? `${retries.length} 次重试` : ''}
      </summary>
      <div className="tool-list">
        {[...tools.values()].map((event) => (
          <div
            className="tool-row"
            key={String(event.payload.toolCallId ?? event.eventId)}
          >
            <span
              className={`tool-state tool-state-${String(event.payload.status ?? 'started')}`}
            />
            <div>
              <strong>{toolLabel(event.payload.name)}</strong>
              <small>
                {String(
                  event.payload.summary ??
                    (event.type === 'tool.started'
                      ? '正在调用…'
                      : event.type === 'tool.failed'
                        ? '调用失败'
                        : '调用完成'),
                )}
              </small>
            </div>
          </div>
        ))}
        {retries.map((event) => (
          <div className="tool-row" key={event.eventId}>
            <span className="tool-state tool-state-started" />
            <div>
              <strong>正在重试</strong>
              <small>
                第 {String(event.payload.attempt ?? '?')} 次执行未完成
              </small>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

export function WorkspaceClient() {
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [eventsByRun, setEventsByRun] = useState<Record<string, RunEvent[]>>(
    {},
  );
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>(
    [],
  );
  const [uploadVisibility, setUploadVisibility] =
    useState<Visibility>('private');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const streamingRuns = useRef(new Set<string>());

  const tenantHeaders = useMemo<Record<string, string>>(() => {
    if (!workspace) return {} as Record<string, string>;
    return {
      'x-allrice-organization-id': workspace.organizationId,
      'x-allrice-workspace-id': workspace.workspaceId,
    };
  }, [workspace]);

  const loadWorkspace = useCallback(async () => {
    const result = await readJson<{ workspace: WorkspacePayload }>(
      await fetch('/api/v1/workspace', { cache: 'no-store' }),
    );
    setWorkspace(result.workspace);
    setActiveId(
      (current) =>
        current ??
        result.workspace.sessions.find((session) => !session.archivedAt)?.id ??
        null,
    );
  }, []);

  const loadHistory = useCallback(
    async (sessionId: string) => {
      if (!workspace) return;
      const result = await readJson<{ history: HistoryPayload }>(
        await fetch(
          `/api/v1/sessions/${sessionId}?workspaceId=${workspace.workspaceId}`,
          { cache: 'no-store', headers: tenantHeaders },
        ),
      );
      setHistory(result.history);
      const runIds = result.history.messages
        .map((message) => message.runId)
        .filter((runId): runId is string => Boolean(runId));
      await Promise.all(
        runIds.map(async (runId) => {
          const replay = await readJson<{ events: RunEvent[] }>(
            await fetch(
              `/api/v1/runs/${runId}/events?workspaceId=${workspace.workspaceId}&format=json`,
              { cache: 'no-store', headers: tenantHeaders },
            ),
          );
          setEventsByRun((current) => ({ ...current, [runId]: replay.events }));
        }),
      );
    },
    [tenantHeaders, workspace],
  );

  const streamRun = useCallback(
    async (runId: string) => {
      if (!workspace || streamingRuns.current.has(runId)) return;
      streamingRuns.current.add(runId);
      const existing = eventsByRun[runId] ?? [];
      const headers: Record<string, string> = { ...tenantHeaders };
      const last = existing.at(-1);
      if (last) headers['last-event-id'] = `${runId}:${last.sequence}`;
      try {
        const response = await fetch(
          `/api/v1/runs/${runId}/events?workspaceId=${workspace.workspaceId}`,
          { headers, cache: 'no-store' },
        );
        if (!response.ok || !response.body) await readJson(response);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
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
            const event = JSON.parse(data) as RunEvent;
            setEventsByRun((current) => {
              const values = current[runId] ?? [];
              if (values.some((value) => value.eventId === event.eventId))
                return current;
              return { ...current, [runId]: [...values, event] };
            });
          }
        }
      } catch (cause) {
        setError(`实时连接中断：${errorMessage(cause)}`);
      } finally {
        streamingRuns.current.delete(runId);
        if (activeId) await loadHistory(activeId).catch(() => undefined);
        await loadWorkspace().catch(() => undefined);
      }
    },
    [
      activeId,
      eventsByRun,
      loadHistory,
      loadWorkspace,
      tenantHeaders,
      workspace,
    ],
  );

  useEffect(() => {
    loadWorkspace().catch((cause) => setError(errorMessage(cause)));
  }, [loadWorkspace]);

  useEffect(() => {
    if (!activeId) {
      setHistory(null);
      return;
    }
    loadHistory(activeId).catch((cause) => setError(errorMessage(cause)));
  }, [activeId, loadHistory]);

  useEffect(() => {
    for (const message of history?.messages ?? []) {
      if (message.status === 'pending' && message.runId)
        void streamRun(message.runId);
    }
  }, [history, streamRun]);

  async function createSession() {
    if (!workspace) return;
    setBusy(true);
    setError('');
    try {
      const result = await readJson<{ session: Session }>(
        await fetch('/api/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            title: '新的对话',
          }),
        }),
      );
      setWorkspace({
        ...workspace,
        sessions: [result.session, ...workspace.sessions],
      });
      setActiveId(result.session.id);
      setPendingAttachments([]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function updateSession(update: { title?: string; archived?: boolean }) {
    if (!workspace || !activeId) return;
    try {
      const result = await readJson<{ session: Session }>(
        await fetch(
          `/api/v1/sessions/${activeId}?workspaceId=${workspace.workspaceId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify(update),
          },
        ),
      );
      const sessions = workspace.sessions.map((item) =>
        item.id === result.session.id ? result.session : item,
      );
      setWorkspace({ ...workspace, sessions });
      if (result.session.archivedAt) {
        setActiveId(sessions.find((item) => !item.archivedAt)?.id ?? null);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function uploadAttachment(file: File) {
    if (!workspace || !activeId) return;
    if (file.size > 8_000_000) return setError('附件不能超过 8 MB。');
    const mediaType =
      file.type ||
      (file.name.endsWith('.md')
        ? 'text/markdown'
        : file.name.endsWith('.txt')
          ? 'text/plain'
          : file.name.endsWith('.json')
            ? 'application/json'
            : '');
    if (!mediaType) return setError('不支持这种附件格式。');
    setBusy(true);
    try {
      const result = await readJson<{
        attachment: Omit<Attachment, 'restricted'>;
      }>(
        await fetch(
          `/api/v1/sessions/${activeId}/attachments?workspaceId=${workspace.workspaceId}`,
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
        ...current,
        { ...result.attachment, restricted: false },
      ]);
    } catch (cause) {
      setError(errorMessage(cause));
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
      setError(errorMessage(cause));
    }
  }

  async function addWorkspaceFile(file: WorkspaceFile) {
    if (!workspace || !activeId) return;
    try {
      await readJson(
        await fetch(
          `/api/v1/sessions/${activeId}/attachments?workspaceId=${workspace.workspaceId}`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({ objectId: file.id }),
          },
        ),
      );
      setPendingAttachments((current) =>
        current.some((item) => item.id === file.id)
          ? current
          : [...current, { ...file, restricted: false }],
      );
      setFilePickerOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function sendMessage() {
    if (!workspace || !activeId || !draft.trim()) return;
    const text = draft.trim();
    setBusy(true);
    setError('');
    setDraft('');
    try {
      const created = await readJson<{ run: { id: string } }>(
        await fetch(
          `/api/v1/sessions/${activeId}/messages?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({
              clientMessageId: crypto.randomUUID(),
              text,
              attachmentIds: pendingAttachments.map((file) => file.id),
            }),
          },
        ),
      );
      setPendingAttachments([]);
      await loadHistory(activeId);
      void streamRun(created.run.id);
    } catch (cause) {
      setDraft(text);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function cancelRun(runId: string) {
    if (!workspace) return;
    try {
      await readJson(
        await fetch(
          `/api/v1/runs/${runId}/cancel?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify({ reason: 'user_requested' }),
          },
        ),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function logout() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  }

  if (!workspace) {
    return (
      <main className="workspace-loading">
        <p>{error || '正在恢复工作区…'}</p>
      </main>
    );
  }

  return (
    <main className="workspace-shell rice-workspace">
      <aside className="workspace-sidebar">
        <div className="rice-brand">
          <span>R</span>
          <div>
            <strong>AllRice</strong>
            <small>你的 AI 工作台</small>
          </div>
        </div>
        <nav className="primary-menu" aria-label="主菜单">
          <button className="primary-menu-active">与 Rice 工作</button>
        </nav>
        <button className="new-chat" disabled={busy} onClick={createSession}>
          ＋ 新建对话
        </button>
        <p className="sidebar-section-title">最近对话</p>
        <nav className="session-list" aria-label="对话列表">
          {workspace.sessions
            .filter((session) => !session.archivedAt)
            .map((session) => (
              <button
                className={session.id === activeId ? 'session-active' : ''}
                key={session.id}
                onClick={() => {
                  setActiveId(session.id);
                  setPendingAttachments([]);
                }}
              >
                <strong>{session.title}</strong>
                <span>{new Date(session.updatedAt).toLocaleDateString()}</span>
              </button>
            ))}
        </nav>
        {workspace.canAdminister ? (
          <a className="text-action" href="/skillhub">
            管理 Rice 技能
          </a>
        ) : null}
        <button className="text-action" onClick={logout}>
          退出登录
        </button>
      </aside>

      <section className="conversation-panel">
        <header className="conversation-header">
          <div>
            <p className="eyebrow">与 Rice 工作</p>
            <h2>{history?.session.title ?? '开始一段对话'}</h2>
          </div>
          {history ? (
            <div className="session-actions">
              <button
                onClick={() => {
                  const title = window.prompt(
                    '新的对话名称',
                    history.session.title,
                  );
                  if (title?.trim())
                    void updateSession({ title: title.trim() });
                }}
              >
                重命名
              </button>
              <button onClick={() => void updateSession({ archived: true })}>
                归档
              </button>
            </div>
          ) : null}
        </header>

        <div className="message-list" aria-live="polite">
          {history?.messages.map((message, index) => {
            const events = message.runId
              ? (eventsByRun[message.runId] ?? [])
              : [];
            const streamed = [...events]
              .reverse()
              .find((event) => event.type === 'assistant.text.completed');
            const text =
              streamed && typeof streamed.payload.text === 'string'
                ? streamed.payload.text
                : message.content.text;
            const previousUser = [...history.messages.slice(0, index)]
              .reverse()
              .find((item) => item.role === 'user');
            return (
              <article
                className={`message message-${message.role}`}
                key={message.id}
              >
                <div className="message-meta">
                  <span>{message.role === 'assistant' ? 'Rice' : '你'}</span>
                  <time>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                <p>{text}</p>
                {message.runId ? <RunDetails events={events} /> : null}
                {message.status === 'pending' ? (
                  <div className="message-progress">
                    <span className="thinking-dot" />
                    Rice 正在处理
                    <button onClick={() => void cancelRun(message.runId!)}>
                      停止
                    </button>
                  </div>
                ) : null}
                {message.status === 'failed' ? (
                  <div className="message-failed">
                    这次没有完成。
                    <button
                      onClick={() => setDraft(previousUser?.content.text ?? '')}
                    >
                      重新编辑
                    </button>
                  </div>
                ) : null}
                {message.attachments.map((attachment) => (
                  <div className="attachment-row" key={attachment.id}>
                    <span>📎 {attachment.fileName}</span>
                  </div>
                ))}
              </article>
            );
          })}
          {history && history.messages.length === 0 ? (
            <div className="empty-conversation">
              <div className="rice-empty-avatar">R</div>
              <h3>Rice 已准备好</h3>
              <p>
                直接描述你要完成的工作；需要资料时，可以从工作区添加或从本地上传。
              </p>
            </div>
          ) : null}
          {!history ? (
            <div className="empty-conversation">
              <h3>创建一个对话开始工作</h3>
            </div>
          ) : null}
        </div>

        {history ? (
          <div className="composer">
            {pendingAttachments.length ? (
              <div className="pending-files">
                {pendingAttachments.map((file) => (
                  <span key={file.id}>
                    📎 {file.fileName}
                    <button
                      onClick={() =>
                        setPendingAttachments((items) =>
                          items.filter((item) => item.id !== file.id),
                        )
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              aria-label="消息"
              placeholder="告诉 Rice 你想完成什么…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <div className="composer-actions">
              <div className="attachment-actions">
                <button
                  disabled={busy}
                  onClick={() => void openWorkspaceFiles()}
                >
                  从工作区添加
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  accept=".txt,.md,.json,.pdf,.png,.jpg,.jpeg,.webp"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadAttachment(file);
                  }}
                />
                <button
                  disabled={busy}
                  onClick={() => fileInput.current?.click()}
                >
                  从本地上传
                </button>
                <select
                  aria-label="上传文件可见范围"
                  value={uploadVisibility}
                  onChange={(event) =>
                    setUploadVisibility(event.target.value as Visibility)
                  }
                >
                  <option value="private">保持私有</option>
                  <option value="workspace">工作区公开</option>
                </select>
              </div>
              <button
                className="send-action"
                disabled={busy || !draft.trim()}
                onClick={sendMessage}
                aria-label="发送"
              >
                ↑
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p className="workspace-error" role="alert">
            {error}
            <button onClick={() => setError('')}>×</button>
          </p>
        ) : null}
      </section>

      {filePickerOpen ? (
        <div
          className="file-picker-backdrop"
          role="presentation"
          onClick={() => setFilePickerOpen(false)}
        >
          <section
            className="file-picker"
            role="dialog"
            aria-modal="true"
            aria-label="从工作区添加文件"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p className="eyebrow">工作区文件</p>
                <h2>选择要交给 Rice 的文件</h2>
              </div>
              <button onClick={() => setFilePickerOpen(false)}>×</button>
            </header>
            <div className="workspace-file-list">
              {workspaceFiles.map((file) => (
                <button
                  key={file.id}
                  onClick={() => void addWorkspaceFile(file)}
                >
                  <span>📄</span>
                  <div>
                    <strong>{file.fileName}</strong>
                    <small>
                      {file.visibility === 'private' ? '仅自己' : '工作区公开'}{' '}
                      · {Math.ceil(file.sizeBytes / 1024)} KB
                    </small>
                  </div>
                  <em>添加</em>
                </button>
              ))}
              {workspaceFiles.length === 0 ? (
                <p className="muted">工作区还没有可用文件。</p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
