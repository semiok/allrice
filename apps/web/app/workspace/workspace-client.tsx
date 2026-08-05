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
    citations: { type: 'memory' | 'file'; id: string; label: string }[];
  };
  attachments: Attachment[];
  createdAt: string;
}

interface Session {
  id: string;
  title: string;
  visibility: Visibility;
  updatedAt: string;
  archivedAt: string | null;
}

interface Memory {
  id: string;
  content: string;
  visibility: Visibility;
  sourceType: 'user' | 'message' | 'file';
  sourceId: string | null;
}

interface WorkspacePayload {
  organizationId: string;
  workspaceId: string;
  employee: {
    version: { name: string; model: string; capabilities: string[] };
  };
  sessions: Session[];
  memories: Memory[];
}

interface HistoryPayload {
  session: Session;
  messages: Message[];
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

export function WorkspaceClient() {
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [draft, setDraft] = useState('');
  const [memoryDraft, setMemoryDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const tenantHeaders = useMemo<Record<string, string>>(() => {
    const headers: Record<string, string> = {};
    if (workspace) {
      headers['x-allrice-organization-id'] = workspace.organizationId;
      headers['x-allrice-workspace-id'] = workspace.workspaceId;
    }
    return headers;
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
    },
    [tenantHeaders, workspace],
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

  async function updateSession(
    update: Partial<Pick<Session, 'title' | 'visibility'>> & {
      archived?: boolean;
    },
    sessionId = activeId,
  ) {
    if (!workspace || !sessionId) return;
    setBusy(true);
    setError('');
    try {
      const result = await readJson<{ session: Session }>(
        await fetch(
          `/api/v1/sessions/${sessionId}?workspaceId=${workspace.workspaceId}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', ...tenantHeaders },
            body: JSON.stringify(update),
          },
        ),
      );
      const sessions = workspace.sessions.map((session) =>
        session.id === result.session.id ? result.session : session,
      );
      setWorkspace({ ...workspace, sessions });
      if (result.session.archivedAt) {
        setActiveId(
          sessions.find((session) => !session.archivedAt)?.id ?? null,
        );
      } else if (update.archived === false) {
        setActiveId(result.session.id);
      } else {
        setHistory((current) =>
          current ? { ...current, session: result.session } : current,
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function uploadAttachment(file: File) {
    if (!workspace || !activeId) return;
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

  async function sendMessage() {
    if (!workspace || !activeId || !draft.trim()) return;
    const text = draft.trim();
    setBusy(true);
    setError('');
    setDraft('');
    try {
      const response = await fetch(
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
      );
      if (!response.ok) await readJson(response);
      await response.text();
      setPendingAttachments([]);
      await Promise.all([loadHistory(activeId), loadWorkspace()]);
    } catch (cause) {
      setDraft(text);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function createMemory(input: {
    content: string;
    sourceType: Memory['sourceType'];
    sourceId: string | null;
  }) {
    if (!workspace || !input.content.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await readJson<{ memory: Memory }>(
        await fetch('/api/v1/memories', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            content: input.content.trim(),
            visibility: 'private',
            sourceType: input.sourceType,
            sourceId: input.sourceId,
          }),
        }),
      );
      setWorkspace({
        ...workspace,
        memories: [result.memory, ...workspace.memories],
      });
      setMemoryDraft('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function deleteMemory(id: string) {
    if (!workspace) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/v1/memories/${id}?workspaceId=${workspace.workspaceId}`,
        { method: 'DELETE', headers: tenantHeaders },
      );
      if (!response.ok) await readJson(response);
      setWorkspace({
        ...workspace,
        memories: workspace.memories.filter((memory) => memory.id !== id),
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function downloadAttachment(attachment: Attachment) {
    if (!workspace || attachment.restricted) return;
    try {
      const result = await readJson<{ url: string }>(
        await fetch(`/api/v1/files/${attachment.id}/sign`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({ lifetimeSeconds: 120 }),
        }),
      );
      window.open(result.url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function deleteAttachment(attachment: Attachment) {
    if (!workspace || attachment.restricted) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/files/${attachment.id}`, {
        method: 'DELETE',
        headers: tenantHeaders,
      });
      if (!response.ok) await readJson(response);
      if (activeId) await loadHistory(activeId);
      await loadWorkspace();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  }

  if (!workspace) {
    return (
      <main className="workspace-loading">
        <p>{error || '正在恢复你的工作空间…'}</p>
      </main>
    );
  }

  return (
    <main className="workspace-shell">
      <aside className="workspace-sidebar">
        <div>
          <p className="eyebrow">ALLRICE · PERSONAL AI</p>
          <h1 className="workspace-logo">{workspace.employee.version.name}</h1>
          <p className="employee-model">{workspace.employee.version.model}</p>
        </div>
        <button
          className="primary-action"
          disabled={busy}
          onClick={createSession}
        >
          ＋ 新建对话
        </button>
        <a className="sidebar-link" href="/skillhub">
          打开 SkillHub
        </a>
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
                <span>
                  {session.visibility === 'private' ? '仅自己' : '已共享'}
                </span>
              </button>
            ))}
          {workspace.sessions.every((session) => session.archivedAt) ? (
            <p className="muted">还没有对话，创建一个开始吧。</p>
          ) : null}
        </nav>
        {workspace.sessions.some((session) => session.archivedAt) ? (
          <details className="archived-sessions">
            <summary>已归档</summary>
            {workspace.sessions
              .filter((session) => session.archivedAt)
              .map((session) => (
                <button
                  disabled={busy}
                  key={session.id}
                  onClick={() =>
                    void updateSession({ archived: false }, session.id)
                  }
                >
                  恢复 {session.title}
                </button>
              ))}
          </details>
        ) : null}
        <button className="text-action" onClick={logout}>
          退出登录
        </button>
      </aside>

      <section className="conversation-panel">
        <header className="conversation-header">
          <div>
            <p className="eyebrow">EMPLOYEE WORKSPACE</p>
            <h2>{history?.session.title ?? '选择一个对话'}</h2>
          </div>
          {history ? (
            <div className="session-actions">
              <button
                disabled={busy}
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
              <button
                disabled={busy}
                onClick={() =>
                  void updateSession({
                    visibility:
                      history.session.visibility === 'private'
                        ? 'workspace'
                        : 'private',
                  })
                }
              >
                {history.session.visibility === 'private' ? '共享' : '设为私有'}
              </button>
              <button
                disabled={busy}
                onClick={() => void updateSession({ archived: true })}
              >
                归档
              </button>
            </div>
          ) : null}
        </header>

        <div className="message-list" aria-live="polite">
          {history?.messages.map((message) => (
            <article
              className={`message message-${message.role}`}
              key={message.id}
            >
              <div className="message-meta">
                <span>
                  {message.role === 'assistant'
                    ? workspace.employee.version.name
                    : '你'}
                </span>
                <time>{new Date(message.createdAt).toLocaleString()}</time>
              </div>
              <p>{message.content.text}</p>
              {message.attachments.map((attachment) => (
                <div className="attachment-row" key={attachment.id}>
                  <span>{attachment.fileName}</span>
                  {!attachment.restricted ? (
                    <span>
                      <button
                        onClick={() => void downloadAttachment(attachment)}
                      >
                        下载
                      </button>
                      <button
                        onClick={() =>
                          void createMemory({
                            content: `文件：${attachment.fileName}`,
                            sourceType: 'file',
                            sourceId: attachment.id,
                          })
                        }
                      >
                        记住
                      </button>
                      <button onClick={() => void deleteAttachment(attachment)}>
                        删除
                      </button>
                    </span>
                  ) : (
                    <em>无权查看</em>
                  )}
                </div>
              ))}
              {message.content.citations.length ? (
                <ul className="citation-list">
                  {message.content.citations.map((citation) => (
                    <li key={`${citation.type}-${citation.id}`}>
                      {citation.label}
                    </li>
                  ))}
                </ul>
              ) : null}
              <button
                className="remember-action"
                disabled={busy}
                onClick={() =>
                  void createMemory({
                    content: message.content.text,
                    sourceType: 'message',
                    sourceId: message.id,
                  })
                }
              >
                记住这条消息
              </button>
            </article>
          ))}
          {history && history.messages.length === 0 ? (
            <div className="empty-conversation">
              <h3>从一件具体的事开始</h3>
              <p>
                这版支持同步问答、附件和可追溯记忆；后台执行将在下一阶段接入。
              </p>
            </div>
          ) : null}
        </div>

        {history ? (
          <div className="composer">
            {pendingAttachments.length ? (
              <div className="pending-files">
                {pendingAttachments.map((file) => (
                  <span key={file.id}>{file.fileName}</span>
                ))}
              </div>
            ) : null}
            <textarea
              aria-label="消息"
              placeholder="给你的 AI 员工发消息…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <div>
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
                添加附件
              </button>
              <button
                className="primary-action"
                disabled={busy || !draft.trim()}
                onClick={sendMessage}
              >
                {busy ? '处理中…' : '发送'}
              </button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p className="workspace-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <aside className="memory-panel">
        <p className="eyebrow">EXPLICIT MEMORY</p>
        <h2>我的记忆</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createMemory({
              content: memoryDraft,
              sourceType: 'user',
              sourceId: null,
            });
          }}
        >
          <textarea
            placeholder="明确告诉 AllRice 要记住什么"
            value={memoryDraft}
            onChange={(event) => setMemoryDraft(event.target.value)}
          />
          <button
            className="primary-action"
            disabled={busy || !memoryDraft.trim()}
          >
            保存记忆
          </button>
        </form>
        <div className="memory-list">
          {workspace.memories.map((memory) => (
            <article key={memory.id}>
              <p>{memory.content}</p>
              <div>
                <span>{memory.sourceType}</span>
                <button
                  disabled={busy}
                  onClick={() => void deleteMemory(memory.id)}
                >
                  删除
                </button>
              </div>
            </article>
          ))}
          {workspace.memories.length === 0 ? (
            <p className="muted">还没有保存记忆。</p>
          ) : null}
        </div>
      </aside>
    </main>
  );
}
