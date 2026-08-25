'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AppSidebar } from '../components/app-sidebar';
import { assistantStreamText } from '../../lib/execution/assistant-stream';

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
    citations: {
      type: string;
      id: string;
      label: string;
      documentId?: string;
      locator?: {
        sourceRef: string;
        chunk: number;
        start: number;
        end: number;
      };
      updatedAt?: string;
    }[];
  };
  attachments: Attachment[];
  status: 'pending' | 'completed' | 'failed';
  runId: string | null;
  createdAt: string;
}

interface Session {
  id: string;
  title: string;
  employeeAssignmentId: string;
  employeeVersionId: string;
  visibility: Visibility;
  updatedAt: string;
  archivedAt: string | null;
}

interface SessionContextStatus {
  pressureTokens: number;
  thresholdTokens: number;
  remainingTokens: number;
  percentage: number;
  compactionDue: boolean;
}

interface RiceVersionChoice {
  id: string;
  version: number;
  manifest: {
    name: string;
    description?: string;
    partnerProfile?: {
      role: string;
      mission: string;
      proactivePolicy?: 'suggest' | 'ask' | 'disabled';
      approvalPolicy?:
        'confirm_side_effects' | 'confirm_external' | 'autonomous';
    };
    capabilities?: string[];
    skillVersionIds?: string[];
  };
}

interface RiceEmployeeChoice {
  id: string;
  employeeId: string;
  employeeKey: string;
  isDefault: boolean;
  memoryCount?: number;
  currentVersion: RiceVersionChoice;
  versions: RiceVersionChoice[];
}

interface EmployeeWorkGroup {
  id: string;
  name: string;
  employee: RiceEmployeeChoice | null;
  sessions: Session[];
}

interface WorkspacePayload {
  organizationId: string;
  workspaceId: string;
  employee: {
    id: string;
    employeeVersionId: string;
    version: { id: string; version: number; name: string };
  };
  employees: RiceEmployeeChoice[];
  sessions: Session[];
  canAdminister: boolean;
}

function renderInlineMessageText(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={`${part}-${index}`}>{part.slice(1, -1)}</code>;
    }
    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

function MessageContent({ text }: { text: string }) {
  const blocks = text
    .trim()
    .split(/\n{2,}/)
    .filter(Boolean);

  return (
    <div className="message-content">
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n').filter((line) => line.trim());
        const singleLine = lines.length === 1 ? lines[0] : undefined;
        const heading = singleLine?.match(/^#{1,3}\s+(.+)$/);
        const isUnorderedList =
          lines.length > 1 && lines.every((line) => /^\s*[-*]\s+/.test(line));
        const isOrderedList =
          lines.length > 1 &&
          lines.every((line) => /^\s*\d+[.)]\s+/.test(line));
        const isQuote = lines.every((line) => /^\s*>\s?/.test(line));

        if (heading?.[1]) {
          return (
            <h3 key={`heading-${blockIndex}`}>
              {renderInlineMessageText(heading[1])}
            </h3>
          );
        }

        if (isUnorderedList || isOrderedList) {
          const List = isOrderedList ? 'ol' : 'ul';
          return (
            <List key={`list-${blockIndex}`}>
              {lines.map((line, lineIndex) => (
                <li key={`item-${blockIndex}-${lineIndex}`}>
                  {renderInlineMessageText(
                    line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''),
                  )}
                </li>
              ))}
            </List>
          );
        }

        if (isQuote) {
          return (
            <blockquote key={`quote-${blockIndex}`}>
              {lines.map((line, lineIndex) => (
                <span key={`quote-${blockIndex}-${lineIndex}`}>
                  {renderInlineMessageText(line.replace(/^\s*>\s?/, ''))}
                  {lineIndex < lines.length - 1 ? <br /> : null}
                </span>
              ))}
            </blockquote>
          );
        }

        return (
          <p key={`paragraph-${blockIndex}`}>
            {lines.map((line, lineIndex) => (
              <span key={`line-${blockIndex}-${lineIndex}`}>
                {renderInlineMessageText(line)}
                {lineIndex < lines.length - 1 ? <br /> : null}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

interface AutomationTaskSnapshot {
  id: string;
  name: string;
  lastSessionId: string | null;
  lastRunAt: string | null;
  lastRunStatus:
    'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | null;
}

interface AutomationToast {
  automationId: string;
  name: string;
  sessionId: string | null;
}

interface HistoryPayload {
  session: Session;
  messages: Message[];
  contextStatus: SessionContextStatus;
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

interface WorkspaceMemory {
  id: string;
  content: string;
  visibility: Visibility;
  sourceType: 'user' | 'message' | 'file';
  createdAt: string;
  updatedAt: string;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求失败，请稍后重试。';
}

function SessionContextMeter({ status }: { status: SessionContextStatus }) {
  const label = status.compactionDue
    ? '上下文 100% · 待压缩'
    : `上下文 ${status.percentage}%`;
  return (
    <div
      className={`session-context-status${
        status.percentage >= 80 ? ' session-context-status-warning' : ''
      }`}
      title={`当前 ${status.pressureTokens.toLocaleString()} / ${status.thresholdTokens.toLocaleString()} tokens；达到 100% 后自动压缩`}
    >
      <span>{label}</span>
      <span
        aria-label={`会话上下文使用 ${status.percentage}%，达到 100% 后自动压缩`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={status.percentage}
        className="session-context-meter"
        role="progressbar"
      >
        <span style={{ width: `${status.percentage}%` }} />
      </span>
    </div>
  );
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

function approvalPolicyLabel(policy: string | undefined) {
  return (
    {
      confirm_side_effects: '有副作用的动作先确认',
      confirm_external: '外部动作先确认',
      autonomous: '在授权范围内自动执行',
    }[policy ?? 'confirm_side_effects'] ?? '有副作用的动作先确认'
  );
}

function starterPrompts(employee: RiceEmployeeChoice | undefined) {
  const key = employee?.employeeKey ?? '';
  const starters: Record<string, string[]> = {
    'builtin-ecommerce-analyst': [
      '请根据工作区资料做一份经营晨报，先给结论，再列出异常、数据缺口和今天的行动建议。',
      '分析最近的经营数据，找出最值得关注的 3 个变化，并说明每个变化对应的证据和下一步。',
    ],
    'builtin-short-video-growth': [
      '请结合工作区资料和近期节气，制定一周内容计划，给出选题、开头话术、素材和优先级。',
      '把这个文化主题拆成 3 个适合短视频的内容方向，并分别说明受众、看点和风险。',
    ],
    'builtin-sales-coach': [
      '请整理重点客户和项目跟进清单，按紧急程度排序，并给出下一次沟通建议。',
      '根据现有客户资料，找出可能的合作机会、证据和需要先确认的问题。',
    ],
    'builtin-growth-strategist': [
      '请把这个项目拆成目标、里程碑、负责人、风险和本周可执行的 3 个动作。',
      '请复盘最近的项目或活动，区分事实、问题根因和下一轮应该验证的改进方案。',
    ],
  };
  return (
    starters[key] ?? [
      '请先确认这个任务的目标、可用资料和交付格式，再给出执行计划并开始处理。',
      '把我的目标拆成可执行的步骤，标出需要我确认的决定和你可以直接完成的部分。',
    ]
  );
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

export function WorkspaceClient({
  hideSidebar = false,
}: {
  hideSidebar?: boolean;
}) {
  const [workspace, setWorkspace] = useState<WorkspacePayload | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [eventsByRun, setEventsByRun] = useState<Record<string, RunEvent[]>>(
    {},
  );
  const [rememberedMessageIds, setRememberedMessageIds] = useState<Set<string>>(
    new Set(),
  );
  const [draft, setDraft] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [collapsedEmployeeGroups, setCollapsedEmployeeGroups] = useState<
    Set<string>
  >(new Set());
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>(
    [],
  );
  const [uploadVisibility, setUploadVisibility] =
    useState<Visibility>('private');
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [memories, setMemories] = useState<WorkspaceMemory[]>([]);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [automationToast, setAutomationToast] =
    useState<AutomationToast | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const streamingRuns = useRef(new Set<string>());
  const automationRunState = useRef(new Map<string, string>());
  const automationPollingStarted = useRef(false);
  const automationToastTimer = useRef<number | null>(null);

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
    setSelectedEmployeeId(
      (current) =>
        new URLSearchParams(window.location.search).get('employeeId') ||
        current ||
        result.workspace.employees.find((employee) => employee.isDefault)?.id ||
        result.workspace.employee.id,
    );
    const requestedEmployeeId = new URLSearchParams(window.location.search).get(
      'employeeId',
    );
    if (
      requestedEmployeeId &&
      result.workspace.employees.some(
        (employee) => employee.id === requestedEmployeeId,
      )
    ) {
      setNewTaskOpen(true);
    }
    const firstSession = result.workspace.sessions.find(
      (session) => !session.archivedAt,
    );
    setNewTaskOpen((current) => current || !firstSession);
    const requestedSessionId = new URLSearchParams(window.location.search).get(
      'sessionId',
    );
    setActiveId((current) =>
      newTaskOpen
        ? null
        : (current ??
          (requestedSessionId &&
          result.workspace.sessions.some(
            (session) =>
              session.id === requestedSessionId && !session.archivedAt,
          )
            ? requestedSessionId
            : null) ??
          result.workspace.sessions.find((session) => !session.archivedAt)
            ?.id ??
          null),
    );
  }, [newTaskOpen]);

  const pollAutomationRuns = useCallback(
    async (currentWorkspace: WorkspacePayload) => {
      const response = await fetch(
        `/api/v1/automations?workspaceId=${currentWorkspace.workspaceId}`,
        {
          cache: 'no-store',
          headers: {
            'x-allrice-organization-id': currentWorkspace.organizationId,
            'x-allrice-workspace-id': currentWorkspace.workspaceId,
          },
        },
      );
      const result = await readJson<{ automations: AutomationTaskSnapshot[] }>(
        response,
      );
      const nextState = new Map<string, string>();
      for (const task of result.automations) {
        const signature = `${task.lastRunAt ?? ''}:${task.lastRunStatus ?? ''}`;
        nextState.set(task.id, signature);
        const previous = automationRunState.current.get(task.id);
        if (
          automationPollingStarted.current &&
          previous !== undefined &&
          previous !== signature &&
          task.lastRunStatus === 'succeeded'
        ) {
          setAutomationToast({
            automationId: task.id,
            name: task.name,
            sessionId: task.lastSessionId,
          });
          if (automationToastTimer.current !== null) {
            window.clearTimeout(automationToastTimer.current);
          }
          automationToastTimer.current = window.setTimeout(
            () => setAutomationToast(null),
            8_000,
          );
        }
      }
      automationRunState.current = nextState;
      automationPollingStarted.current = true;
    },
    [],
  );

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
    async (runId: string, sessionId?: string) => {
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
        const currentSessionId = sessionId ?? activeId;
        if (currentSessionId)
          await loadHistory(currentSessionId).catch(() => undefined);
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
    if (!workspace) return;
    automationRunState.current = new Map();
    automationPollingStarted.current = false;
    let disposed = false;
    const poll = async () => {
      if (disposed) return;
      await pollAutomationRuns(workspace).catch(() => undefined);
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [pollAutomationRuns, workspace]);

  useEffect(
    () => () => {
      if (automationToastTimer.current !== null) {
        window.clearTimeout(automationToastTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    const starter = new URLSearchParams(window.location.search).get('starter');
    if (!starter) return;
    setDraft(starter);
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

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

  const riceVersions = useMemo(() => {
    const versions = new Map<string, RiceVersionChoice>();
    for (const employee of workspace?.employees ?? []) {
      for (const version of employee.versions)
        versions.set(version.id, version);
    }
    return [...versions.values()].sort(
      (left, right) => right.version - left.version,
    );
  }, [workspace]);

  const selectedEmployee = useMemo(
    () =>
      workspace?.employees.find(
        (employee) => employee.id === selectedEmployeeId,
      ) ?? workspace?.employees.find((employee) => employee.isDefault),
    [selectedEmployeeId, workspace],
  );

  const employeeWorkGroups = useMemo<EmployeeWorkGroup[]>(() => {
    if (!workspace) return [];
    const sessionsByEmployee = new Map<string, Session[]>();
    const archivedSessions: Session[] = [];
    for (const session of workspace.sessions) {
      if (session.archivedAt) continue;
      const employee = workspace.employees.find(
        (item) =>
          item.id === session.employeeAssignmentId ||
          item.versions.some(
            (version) => version.id === session.employeeVersionId,
          ),
      );
      if (!employee) {
        archivedSessions.push(session);
        continue;
      }
      const sessions = sessionsByEmployee.get(employee.id) ?? [];
      sessions.push(session);
      sessionsByEmployee.set(employee.id, sessions);
    }
    const groups: EmployeeWorkGroup[] = workspace.employees
      .filter(
        (employee) =>
          sessionsByEmployee.has(employee.id) ||
          employee.id === selectedEmployeeId,
      )
      .map((employee) => ({
        id: employee.id,
        name: employee.currentVersion.manifest.name,
        employee,
        sessions: sessionsByEmployee.get(employee.id) ?? [],
      }));
    if (archivedSessions.length > 0) {
      groups.push({
        id: 'archived-employees',
        name: '已归档员工',
        employee: null,
        sessions: archivedSessions,
      });
    }
    return groups;
  }, [selectedEmployeeId, workspace]);

  function employeeVersionLabel(versionId: string) {
    const version = riceVersions.find((item) => item.id === versionId);
    return version
      ? `${employeeLabelForVersion(versionId)} v${version.version}`
      : 'AI员工版本';
  }

  function employeeForVersion(versionId: string) {
    return workspace?.employees.find((employee) =>
      employee.versions.some((version) => version.id === versionId),
    );
  }

  function employeeLabelForVersion(versionId: string) {
    const employee = employeeForVersion(versionId);
    return employee?.currentVersion.manifest.name ?? '已归档 AI员工';
  }

  function toggleEmployeeGroup(groupId: string) {
    setCollapsedEmployeeGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function rememberMessage(message: Message) {
    if (!workspace || !history || message.role !== 'user') return;
    const employee = employeeForVersion(history.session.employeeVersionId);
    if (!employee || rememberedMessageIds.has(message.id)) return;
    setBusy(true);
    try {
      await readJson(
        await fetch('/api/v1/memories', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            employeeId: employee.employeeId,
            content: message.content.text,
            visibility: 'private',
            sourceType: 'message',
            sourceId: message.id,
          }),
        }),
      );
      setRememberedMessageIds((current) => new Set([...current, message.id]));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function startNewTask() {
    setActiveId(null);
    setHistory(null);
    setNewTaskOpen(true);
    setDraft('');
    setPendingAttachments([]);
    setEmployeePickerOpen(false);
    setError('');
  }

  async function ensureActiveSession() {
    if (!workspace) return;
    if (activeId) return activeId;
    const selectedEmployee =
      workspace.employees.find(
        (employee) => employee.id === selectedEmployeeId,
      ) ?? workspace.employees.find((employee) => employee.isDefault);
    if (!selectedEmployee) {
      setError('还没有可用的 AI员工。');
      return null;
    }
    try {
      const result = await readJson<{ session: Session }>(
        await fetch('/api/v1/sessions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            employeeAssignmentId: selectedEmployee.id,
            employeeVersionId: selectedEmployee.currentVersion.id,
            title: draft.trim() ? draft.trim().slice(0, 60) : '新的任务',
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
          pressureTokens: 0,
          thresholdTokens: 40_000,
          remainingTokens: 40_000,
          percentage: 0,
          compactionDue: false,
        },
      });
      setNewTaskOpen(false);
      setEmployeePickerOpen(false);
      window.history.replaceState(null, '', window.location.pathname);
      return result.session.id;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    }
  }

  async function createSession(initialText = '') {
    if (!workspace) return;
    const text = initialText.trim();
    setBusy(true);
    setError('');
    try {
      const sessionId = await ensureActiveSession();
      if (!sessionId) return;
      if (text) {
        const created = await readJson<{ run: { id: string } }>(
          await fetch(
            `/api/v1/sessions/${sessionId}/messages?workspaceId=${workspace.workspaceId}`,
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
        setDraft('');
        setPendingAttachments([]);
        await loadHistory(sessionId);
        void streamRun(created.run.id, sessionId);
      }
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
    if (!workspace) return;
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
      const sessionId = await ensureActiveSession();
      if (!sessionId) return;
      const result = await readJson<{
        attachment: Omit<Attachment, 'restricted'>;
      }>(
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
      setError(errorMessage(cause));
    }
  }, [tenantHeaders, workspace]);

  const openWorkspaceMemories = useCallback(async () => {
    if (!workspace) return;
    try {
      const result = await readJson<{ memories: WorkspaceMemory[] }>(
        await fetch(`/api/v1/memories?workspaceId=${workspace.workspaceId}`, {
          cache: 'no-store',
          headers: tenantHeaders,
        }),
      );
      setMemories(result.memories);
      setMemoryPanelOpen(true);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [tenantHeaders, workspace]);

  useEffect(() => {
    if (!workspace) return;
    window.dispatchEvent(
      new CustomEvent('allrice:workspace-sidebar', {
        detail: {
          groups: employeeWorkGroups.map((group) => ({
            id: group.id,
            name: group.name,
            sessions: group.sessions.map((session) => ({
              id: session.id,
              title: session.title,
              employeeVersionId: session.employeeVersionId,
              updatedAt: session.updatedAt,
            })),
          })),
          activeId,
          canAdminister: workspace.canAdminister,
        },
      }),
    );
  }, [activeId, employeeWorkGroups, workspace]);

  useEffect(() => {
    const receiveWorkspaceAction = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          action?: 'new' | 'files' | 'memory' | 'select-session';
          sessionId?: string;
        }>
      ).detail;
      if (detail.action === 'new') startNewTask();
      if (detail.action === 'files') void openWorkspaceFiles();
      if (detail.action === 'memory') void openWorkspaceMemories();
      if (detail.action === 'select-session' && detail.sessionId) {
        setActiveId(detail.sessionId);
        setNewTaskOpen(false);
        setPendingAttachments([]);
      }
    };
    window.addEventListener('allrice:workspace-action', receiveWorkspaceAction);
    return () =>
      window.removeEventListener(
        'allrice:workspace-action',
        receiveWorkspaceAction,
      );
  }, [openWorkspaceFiles, openWorkspaceMemories]);

  useEffect(() => {
    if (!workspace || window.location.hash !== '#files') return;
    void openWorkspaceFiles();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }, [openWorkspaceFiles, workspace]);

  useEffect(() => {
    if (!workspace || window.location.hash !== '#memory') return;
    void openWorkspaceMemories();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }, [openWorkspaceMemories, workspace]);

  async function createMemory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !memoryDraft.trim()) return;
    setMemoryBusy(true);
    try {
      const result = await readJson<{ memory: WorkspaceMemory }>(
        await fetch('/api/v1/memories', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...tenantHeaders },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            content: memoryDraft.trim(),
            visibility: 'private',
            sourceType: 'user',
            sourceId: null,
          }),
        }),
      );
      setMemories((current) => [result.memory, ...current]);
      setMemoryDraft('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setMemoryBusy(false);
    }
  }

  async function deleteMemory(memoryId: string) {
    if (!workspace) return;
    setMemoryBusy(true);
    try {
      await readJson<void>(
        await fetch(
          `/api/v1/memories/${memoryId}?workspaceId=${workspace.workspaceId}`,
          { method: 'DELETE', headers: tenantHeaders },
        ),
      );
      setMemories((current) =>
        current.filter((memory) => memory.id !== memoryId),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setMemoryBusy(false);
    }
  }

  async function addWorkspaceFile(file: WorkspaceFile) {
    if (!workspace) return;
    setBusy(true);
    try {
      const sessionId = await ensureActiveSession();
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
      setPendingAttachments((current) =>
        current.some((item) => item.id === file.id)
          ? current
          : [...current, { ...file, restricted: false }],
      );
      setFilePickerOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage() {
    if (!workspace || !activeId || !draft.trim()) return;
    const text = draft.trim();
    const activeAssistant = [...(history?.messages ?? [])]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'pending' &&
          message.runId,
      );
    const activeTurnEvent = activeAssistant?.runId
      ? [...(eventsByRun[activeAssistant.runId] ?? [])]
          .reverse()
          .find(
            (event) =>
              typeof event.payload.turnId === 'string' &&
              typeof event.payload.generation === 'number',
          )
      : undefined;
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
              deliveryMode: 'auto',
              ...(activeTurnEvent
                ? {
                    expectedTurnId: activeTurnEvent.payload.turnId,
                    expectedGeneration: activeTurnEvent.payload.generation,
                  }
                : {}),
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

  const contextEmployee = history
    ? (employeeForVersion(history.session.employeeVersionId) ??
      selectedEmployee)
    : selectedEmployee;

  return (
    <main
      className={`workspace-shell rice-workspace${hideSidebar ? ' workspace-panel-only' : ''}`}
    >
      {!hideSidebar ? (
        <AppSidebar
          active="workspace"
          actionsDisabled={busy}
          action={
            <button className="new-chat" disabled={busy} onClick={startNewTask}>
              ＋ 新建任务
            </button>
          }
          className="workspace-sidebar"
          onFiles={() => void openWorkspaceFiles()}
          onMemory={() => void openWorkspaceMemories()}
        >
          <p className="sidebar-section-title">AI员工工作</p>
          <nav className="employee-work-nav" aria-label="AI员工工作区">
            {employeeWorkGroups.map((group) => {
              const collapsed = collapsedEmployeeGroups.has(group.id);
              return (
                <section className="employee-work-group" key={group.id}>
                  <button
                    className="employee-work-heading"
                    type="button"
                    aria-expanded={!collapsed}
                    onClick={() => toggleEmployeeGroup(group.id)}
                  >
                    <span className="employee-work-chevron">
                      {collapsed ? '›' : '⌄'}
                    </span>
                    <span className="primary-menu-icon">◌</span>
                    <span>与 {group.name} 工作</span>
                  </button>
                  {!collapsed ? (
                    <div
                      className="employee-session-list"
                      aria-label={`${group.name}的对话`}
                    >
                      {group.sessions.map((session) => (
                        <button
                          className={
                            session.id === activeId ? 'session-active' : ''
                          }
                          key={session.id}
                          onClick={() => {
                            setActiveId(session.id);
                            setNewTaskOpen(false);
                            setPendingAttachments([]);
                          }}
                        >
                          <strong>{session.title}</strong>
                          <span>
                            {employeeVersionLabel(session.employeeVersionId)} ·{' '}
                            {new Date(session.updatedAt).toLocaleDateString()}
                          </span>
                        </button>
                      ))}
                      {group.sessions.length === 0 ? (
                        <span className="employee-group-empty">暂无对话</span>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </nav>
          {workspace.canAdminister ? (
            <Link className="text-action" href="/skillhub">
              管理 AI员工技能
            </Link>
          ) : null}
          <button className="text-action" onClick={logout}>
            退出登录
          </button>
        </AppSidebar>
      ) : null}

      <section className="conversation-panel">
        <header className="conversation-header">
          <div>
            <p className="eyebrow">
              {history
                ? `与 ${employeeLabelForVersion(history.session.employeeVersionId)} 工作`
                : '新建任务'}
            </p>
            <h2>
              {history?.session.title ?? '选择一位 AI员工开始工作'}
              {history ? (
                <small className="conversation-version">
                  {employeeVersionLabel(history.session.employeeVersionId)}
                </small>
              ) : null}
            </h2>
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
          {!history && newTaskOpen ? (
            <section className="task-launchpad" aria-label="任务启动助手">
              <div className="task-launchpad-heading">
                <div className="rice-empty-avatar">✦</div>
                <div>
                  <p className="eyebrow">BOT BRIEF</p>
                  <h3>
                    {selectedEmployee?.currentVersion.manifest.name ??
                      'AI工作伙伴'}
                    <span>已准备好接手任务</span>
                  </h3>
                  <p>
                    {selectedEmployee?.currentVersion.manifest.partnerProfile
                      ?.mission ??
                      selectedEmployee?.currentVersion.manifest.description ??
                      '描述目标后，我会先梳理范围，再推进可交付结果。'}
                  </p>
                </div>
              </div>
              <div className="task-launchpad-meta">
                <span>
                  角色：
                  {selectedEmployee?.currentVersion.manifest.partnerProfile
                    ?.role ?? '通用工作伙伴'}
                </span>
                <span>
                  {selectedEmployee?.currentVersion.manifest.skillVersionIds
                    ?.length ?? 0}{' '}
                  个 Skill
                </span>
                <span>{selectedEmployee?.memoryCount ?? 0} 条专属记忆</span>
                <span>
                  {approvalPolicyLabel(
                    selectedEmployee?.currentVersion.manifest.partnerProfile
                      ?.approvalPolicy,
                  )}
                </span>
              </div>
              <div className="task-starter-heading">
                <strong>从一个清晰的任务目标开始</strong>
                <span>点击示例会填入输入框，你可以继续修改</span>
              </div>
              <div className="task-starters">
                {starterPrompts(selectedEmployee).map((prompt) => (
                  <button
                    type="button"
                    key={prompt}
                    onClick={() => setDraft(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          {history?.messages.map((message, index) => {
            const events = message.runId
              ? (eventsByRun[message.runId] ?? [])
              : [];
            const text = assistantStreamText(events, message.content.text);
            const previousUser = [...history.messages.slice(0, index)]
              .reverse()
              .find((item) => item.role === 'user');
            return (
              <article
                className={`message message-${message.role}`}
                key={message.id}
              >
                <div className="message-meta">
                  <span>
                    {message.role === 'assistant'
                      ? employeeLabelForVersion(
                          history.session.employeeVersionId,
                        )
                      : '你'}
                  </span>
                  <time>
                    {new Date(message.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                  {message.role === 'user' ? (
                    <button
                      className="remember-message"
                      disabled={busy || rememberedMessageIds.has(message.id)}
                      onClick={() => void rememberMessage(message)}
                    >
                      {rememberedMessageIds.has(message.id)
                        ? '员工已记住'
                        : '让员工记住'}
                    </button>
                  ) : null}
                </div>
                <MessageContent text={text} />
                {message.content.citations.length > 0 ? (
                  <div className="citation-list" aria-label="回答来源">
                    <strong>来源</strong>
                    {message.content.citations.map(
                      (citation, citationIndex) => (
                        <span key={`${citation.type}-${citation.id}`}>
                          [{citationIndex + 1}] {citation.label}
                          {citation.locator
                            ? ` · 第 ${citation.locator.chunk + 1} 段`
                            : ''}
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
                {message.runId ? <RunDetails events={events} /> : null}
                {message.status === 'pending' ? (
                  <div className="message-progress">
                    <span className="thinking-dot" />
                    正在处理…
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
              <div className="rice-empty-avatar">✦</div>
              <h3>员工已准备好</h3>
              <p>
                直接描述你要完成的工作；需要资料时，可以从工作区添加或从本地上传。
              </p>
            </div>
          ) : null}
          {!history && !newTaskOpen ? (
            <div className="empty-conversation">
              <h3>创建一个任务开始工作</h3>
              <button className="empty-primary-action" onClick={startNewTask}>
                新建任务
              </button>
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
              placeholder="描述你想完成的工作…"
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
                <SessionContextMeter status={history.contextStatus} />
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
        {!history && newTaskOpen ? (
          <div className="composer new-task-composer">
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
              aria-label="任务目标"
              autoFocus
              placeholder="输入你的任务或目标"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void createSession(draft);
                }
              }}
            />
            <div className="new-task-toolbar">
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
              <div className="employee-picker">
                <button
                  type="button"
                  className="employee-picker-trigger"
                  onClick={() => setEmployeePickerOpen((open) => !open)}
                  aria-expanded={employeePickerOpen}
                >
                  <span className="employee-picker-avatar">✦</span>
                  <span>
                    {workspace.employees.find(
                      (employee) => employee.id === selectedEmployeeId,
                    )?.currentVersion.manifest.name ?? '选择 AI员工'}
                  </span>
                  <span className="employee-picker-chevron">⌄</span>
                </button>
                {employeePickerOpen ? (
                  <div className="employee-picker-menu" role="menu">
                    <p>选择合作的 AI员工</p>
                    {workspace.employees.map((employee) => (
                      <button
                        type="button"
                        role="menuitem"
                        className={
                          employee.id === selectedEmployeeId
                            ? 'employee-picker-option employee-picker-option-active'
                            : 'employee-picker-option'
                        }
                        key={employee.id}
                        onClick={() => {
                          setSelectedEmployeeId(employee.id);
                          setEmployeePickerOpen(false);
                        }}
                      >
                        <span className="employee-picker-avatar">✦</span>
                        <span>
                          <strong>
                            {employee.currentVersion.manifest.name}
                          </strong>
                          <small>
                            {employee.currentVersion.manifest.description ??
                              '你的工作伙伴'}
                          </small>
                        </span>
                        {employee.id === selectedEmployeeId ? <em>✓</em> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button
                className="send-action"
                disabled={
                  busy || !draft.trim() || workspace.employees.length === 0
                }
                onClick={() => void createSession(draft)}
                aria-label="创建任务"
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

      <aside className="workspace-context-rail">
        <div className="workspace-rail-heading">
          <span>工作上下文</span>
          <span className="workspace-live-dot">LIVE</span>
        </div>
        <div className="workspace-agent-card">
          <div className="workspace-agent-avatar">✦</div>
          <p className="workspace-rail-kicker">当前 AI 员工</p>
          <h3>
            {contextEmployee?.currentVersion.manifest.name ?? 'AI工作伙伴'}
          </h3>
          <p>
            {contextEmployee?.currentVersion.manifest.partnerProfile?.role ??
              '通用工作伙伴'}
          </p>
          <div className="workspace-agent-rule" />
          <small>
            {contextEmployee?.currentVersion.manifest.partnerProfile?.mission ??
              '理解目标、推进任务，并交付可继续协作的结果。'}
          </small>
        </div>
        <div className="workspace-rail-section">
          <div className="workspace-rail-section-title">工作状态</div>
          <div className="workspace-status-row">
            <span className="workspace-status-icon">
              {history ? '◉' : '＋'}
            </span>
            <div>
              <strong>{history ? '任务上下文已连接' : '等待新的任务'}</strong>
              <span>
                {history
                  ? `使用 ${employeeVersionLabel(history.session.employeeVersionId)}`
                  : '描述目标后，员工会先梳理范围'}
              </span>
            </div>
          </div>
        </div>
        <div className="workspace-rail-section">
          <div className="workspace-rail-section-title">执行边界</div>
          <p className="workspace-rail-note">
            {approvalPolicyLabel(
              contextEmployee?.currentVersion.manifest.partnerProfile
                ?.approvalPolicy,
            )}
          </p>
          <p className="workspace-rail-note muted-note">
            权限由工作区策略和已授权 Skill 共同决定。
          </p>
        </div>
        <div className="workspace-rail-section workspace-rail-footer">
          <div className="workspace-rail-stats">
            <span>
              <strong>
                {contextEmployee?.currentVersion.manifest.skillVersionIds
                  ?.length ?? 0}
              </strong>
              Skills
            </span>
            <span>
              <strong>{contextEmployee?.memoryCount ?? 0}</strong>
              记忆
            </span>
          </div>
          <Link href="/employees">管理 AI 员工 →</Link>
        </div>
      </aside>

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
                <h2>选择要添加的文件</h2>
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

      {memoryPanelOpen ? (
        <div
          className="memory-panel-backdrop"
          role="presentation"
          onClick={() => setMemoryPanelOpen(false)}
        >
          <section
            className="memory-panel-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="我的记忆"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="memory-panel-header">
              <div>
                <p className="eyebrow">AI员工的长期参考</p>
                <h2>我的记忆</h2>
                <p>保存项目背景、偏好和规则，让 AI员工在后续对话中持续参考。</p>
              </div>
              <button
                type="button"
                onClick={() => setMemoryPanelOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </header>
            <form className="memory-create-form" onSubmit={createMemory}>
              <textarea
                aria-label="新增记忆"
                placeholder="例如：AllRice 的默认工作区是 MET，汇报用中文。"
                value={memoryDraft}
                onChange={(event) => setMemoryDraft(event.target.value)}
                disabled={memoryBusy}
              />
              <button
                type="submit"
                disabled={memoryBusy || !memoryDraft.trim()}
              >
                {memoryBusy ? '保存中…' : '保存记忆'}
              </button>
            </form>
            <div className="memory-panel-list">
              {memories.map((memory) => (
                <article key={memory.id}>
                  <p>{memory.content}</p>
                  <div>
                    <span>
                      {memory.sourceType === 'user'
                        ? '手动添加'
                        : '来自对话或文件'}{' '}
                      · {new Date(memory.updatedAt).toLocaleDateString()}
                    </span>
                    {memory.sourceType === 'user' ? (
                      <button
                        type="button"
                        disabled={memoryBusy}
                        onClick={() => void deleteMemory(memory.id)}
                      >
                        删除
                      </button>
                    ) : null}
                  </div>
                </article>
              ))}
              {memories.length === 0 ? (
                <p className="muted">
                  还没有记忆。保存一条信息，让 AI员工以后记得它。
                </p>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {automationToast ? (
        <aside className="automation-toast" role="status" aria-live="polite">
          <div className="automation-toast-icon">✓</div>
          <div className="automation-toast-content">
            <strong>{automationToast.name}</strong>
            <span>自动化已执行，任务已在对话中完成提醒。</span>
            {automationToast.sessionId ? (
              <Link href={`/workspace?sessionId=${automationToast.sessionId}`}>
                查看对话
              </Link>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="关闭提醒"
            onClick={() => setAutomationToast(null)}
          >
            ×
          </button>
        </aside>
      ) : null}
    </main>
  );
}
