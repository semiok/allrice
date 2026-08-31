'use client';

import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';

import { AppSidebar } from '../components/app-sidebar';
import { useAppShell } from '../components/app-shell';

type AutomationStatus = 'enabled' | 'paused';
type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
type Frequency = 'once' | 'daily' | 'weekly';
type ConversationMode = 'new_each_run' | 'reuse';

interface Schedule {
  frequency: Frequency;
  time?: string;
  runAt?: string;
  weekday?: number;
  timezone: string;
}

interface AutomationTask {
  id: string;
  name: string;
  description: string;
  prompt: string;
  schedule: Schedule;
  status: AutomationStatus;
  conversationMode: ConversationMode;
  lastSessionId: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
}

interface WorkspaceContext {
  organizationId: string;
  workspaceId: string;
}

const weekdayLabels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function readJson<T>(response: Response): Promise<T> {
  return response.json().then((body: T | { error?: { message?: string } }) => {
    if (response.status === 401) {
      window.location.assign('/login');
      throw new Error('登录状态已失效');
    }
    if (!response.ok) {
      throw new Error(
        (body as { error?: { message?: string } }).error?.message ?? '请求失败',
      );
    }
    return body as T;
  });
}

function scheduleLabel(schedule: Schedule) {
  if (schedule.frequency === 'once') {
    return `一次性 · ${formatDate(schedule.runAt ?? null)}`;
  }
  return schedule.frequency === 'weekly'
    ? `每${weekdayLabels[schedule.weekday ?? 1]} ${schedule.time ?? ''}`
    : `每天 ${schedule.time ?? ''}`;
}

function runLabel(status: RunStatus | null) {
  return {
    queued: '排队中',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    canceled: '已取消',
  }[status ?? 'queued'];
}

function conversationLabel(mode: ConversationMode) {
  return mode === 'reuse' ? '延续固定对话' : '每次新建对话';
}

function formatDate(value: string | null) {
  if (!value) return '尚未执行';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function AutomationClient({ embedded = false }: { embedded?: boolean }) {
  const appShell = useAppShell();
  const [workspace, setWorkspace] = useState<WorkspaceContext | null>(null);
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftFrequency, setDraftFrequency] = useState<Frequency>('daily');
  const [draftTime, setDraftTime] = useState('09:00');
  const [draftWeekday, setDraftWeekday] = useState('1');
  const [draftConversationMode, setDraftConversationMode] =
    useState<ConversationMode>('new_each_run');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const headers = useMemo<Record<string, string>>(() => {
    if (!workspace) return {} as Record<string, string>;
    return {
      'x-allrice-organization-id': workspace.organizationId,
      'x-allrice-workspace-id': workspace.workspaceId,
    } satisfies Record<string, string>;
  }, [workspace]);

  const load = useCallback(async (context: WorkspaceContext) => {
    const contextHeaders = {
      'x-allrice-organization-id': context.organizationId,
      'x-allrice-workspace-id': context.workspaceId,
    };
    const result = await readJson<{ automations: AutomationTask[] }>(
      await fetch(`/api/v1/automations?workspaceId=${context.workspaceId}`, {
        headers: contextHeaders,
        cache: 'no-store',
      }),
    );
    setTasks(result.automations);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const result = await readJson<{ workspace: WorkspaceContext }>(
          await fetch('/api/v1/workspace', { cache: 'no-store' }),
        );
        setWorkspace(result.workspace);
        await load(result.workspace);
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : '自动化加载失败',
        );
      }
    })();
  }, [load]);

  async function toggleTask(task: AutomationTask) {
    if (!workspace) return;
    setBusyId(task.id);
    setError('');
    try {
      const result = await readJson<{ automation: AutomationTask }>(
        await fetch(
          `/api/v1/automations/${task.id}?workspaceId=${workspace.workspaceId}`,
          {
            method: 'PATCH',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              status: task.status === 'enabled' ? 'paused' : 'enabled',
            }),
          },
        ),
      );
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? result.automation : item)),
      );
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : '更新失败');
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(task: AutomationTask) {
    if (!workspace) return;
    setBusyId(task.id);
    setError('');
    try {
      await readJson<{ run: unknown }>(
        await fetch(
          `/api/v1/automations/${task.id}/run?workspaceId=${workspace.workspaceId}`,
          {
            method: 'POST',
            headers,
          },
        ),
      );
      await load(workspace);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : '启动执行失败');
    } finally {
      setBusyId(null);
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !draftName.trim() || !draftPrompt.trim()) return;
    setBusy(true);
    setError('');
    try {
      await readJson<{ automation: AutomationTask }>(
        await fetch('/api/v1/automations', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            workspaceId: workspace.workspaceId,
            name: draftName.trim(),
            description: `${scheduleLabel({ frequency: draftFrequency, time: draftTime, weekday: Number(draftWeekday), timezone: 'Asia/Shanghai' })} · 由 Rice 执行`,
            prompt: draftPrompt.trim(),
            conversationMode: draftConversationMode,
            schedule: {
              frequency: draftFrequency,
              time: draftTime,
              ...(draftFrequency === 'weekly'
                ? { weekday: Number(draftWeekday) }
                : {}),
              timezone: 'Asia/Shanghai',
            },
            enabled: true,
          }),
        }),
      );
      setCreateOpen(false);
      setDraftName('');
      setDraftPrompt('');
      setDraftConversationMode('new_each_run');
      await load(workspace);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  const enabledTasks = tasks.filter((task) => task.status === 'enabled');
  const nextTask = enabledTasks[0] ?? tasks[0];

  return (
    <main
      className={`automation-shell${embedded ? ' automation-panel-only' : ''}`}
    >
      {!embedded ? (
        <AppSidebar
          active="automation"
          action={
            <Link className="new-chat" href="/chatflow">
              ＋ 新建对话
            </Link>
          }
          className="automation-sidebar"
          footer={
            <div className="automation-sidebar-bottom">
              <div className="automation-user">
                <span>A</span>
                <small>当前工作区</small>
              </div>
            </div>
          }
        />
      ) : null}

      <section className="automation-main">
        <header className="automation-header">
          <div>
            <p className="automation-eyebrow">工作流中心</p>
            <h1>自动化</h1>
            <p>让 Rice 在事件发生或时间到达时主动完成工作。</p>
          </div>
          <button
            className="automation-primary"
            type="button"
            onClick={() => setCreateOpen(true)}
          >
            ＋ 新建自动化
          </button>
        </header>
        <div className="automation-tabs" role="tablist" aria-label="工作流类型">
          <button
            className="active"
            type="button"
            role="tab"
            aria-selected="true"
          >
            自动化任务
          </button>
          {appShell ? (
            <button
              type="button"
              role="tab"
              aria-selected="false"
              onClick={() => appShell.navigate('employees')}
            >
              AI员工
            </button>
          ) : (
            <Link href="/employees" role="tab" aria-selected="false">
              AI员工
            </Link>
          )}
        </div>

        <section className="automation-content">
          <div className="automation-section-heading">
            <h2>正在运行</h2>
            <span>
              {enabledTasks.length} 个任务 · 共 {tasks.length} 个
            </span>
          </div>
          {error ? <div className="automation-error">{error}</div> : null}
          <div className="automation-task-list">
            {tasks.length === 0 ? (
              <div className="automation-empty">
                <strong>还没有自动化任务</strong>
                <span>
                  从一个每日摘要或每周回顾开始，让 Rice 主动替你工作。
                </span>
              </div>
            ) : (
              tasks.map((task) => (
                <article className="automation-task" key={task.id}>
                  <div className="automation-task-icon">
                    {task.status === 'enabled' ? '◷' : 'Ⅱ'}
                  </div>
                  <div className="automation-task-body">
                    <h3>{task.name}</h3>
                    <p>
                      {scheduleLabel(task.schedule)} ·{' '}
                      {task.description || '使用 Rice 执行自动化任务'}
                    </p>
                    <div className="automation-tags">
                      <span
                        className={`automation-tag ${task.status === 'enabled' ? 'green' : ''}`}
                      >
                        {task.status === 'enabled' ? '运行中' : '已暂停'}
                      </span>
                      <span className="automation-tag">
                        {task.schedule.timezone}
                      </span>
                      <span className="automation-tag">
                        {conversationLabel(task.conversationMode)}
                      </span>
                      {task.lastRunStatus ? (
                        <span className="automation-tag">
                          上次：{runLabel(task.lastRunStatus)}
                        </span>
                      ) : null}
                    </div>
                    <small className="automation-task-meta">
                      上次执行 {formatDate(task.lastRunAt)} · 下次执行{' '}
                      {formatDate(task.nextRunAt)}
                    </small>
                  </div>
                  <div className="automation-task-actions">
                    {task.lastSessionId ? (
                      <Link
                        className="automation-open-conversation"
                        href={`/chatflow?sessionId=${encodeURIComponent(task.lastSessionId)}`}
                      >
                        打开最近对话
                      </Link>
                    ) : null}
                    <button
                      className="automation-run-now"
                      type="button"
                      disabled={busyId === task.id}
                      onClick={() => void runNow(task)}
                    >
                      立即运行
                    </button>
                    <button
                      className={`automation-status ${task.status}`}
                      type="button"
                      disabled={busyId === task.id}
                      onClick={() => void toggleTask(task)}
                    >
                      {task.status === 'enabled' ? '已启用' : '已暂停'}
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
          {nextTask ? (
            <div className="automation-next">
              <strong>下一次执行</strong>
              <span>
                {nextTask.name} · {formatDate(nextTask.nextRunAt)} · 由 Rice
                处理并写入执行记录
              </span>
            </div>
          ) : null}
        </section>
      </section>

      <aside className="automation-context">
        <div className="automation-context-heading">
          <h2>执行配置</h2>
          <span>···</span>
        </div>
        <div className="automation-agent-card">
          <div className="automation-agent-top">
            <strong>✦</strong>
            <div>
              <b>Rice</b>
              <small>自动化任务的默认执行者</small>
            </div>
          </div>
          <div className="automation-tags">
            <span className="automation-tag green">已连接执行链</span>
            <span className="automation-tag">Codex</span>
          </div>
        </div>
        <div className="automation-context-block">
          <div className="automation-context-label">
            <span>运行方式</span>
            <em>Worker 调度</em>
          </div>
          <div className="automation-skill-row">
            <span>◷</span>
            <div>
              时间触发<small>Worker 持续检查到期任务</small>
            </div>
          </div>
          <div className="automation-skill-row">
            <span>↗</span>
            <div>
              任务队列<small>每次执行拥有独立 Run 与日志</small>
            </div>
          </div>
          <div className="automation-skill-row">
            <span>✓</span>
            <div>
              权限快照<small>沿用当前工作区和 Rice 权限</small>
            </div>
          </div>
        </div>
        <div className="automation-context-block">
          <div className="automation-context-label">
            <span>当前能力</span>
            <em>可扩展</em>
          </div>
          <div className="automation-skill-row">
            <span>⌁</span>
            <div>
              工作区记忆<small>作为任务上下文进行检索</small>
            </div>
          </div>
          <div className="automation-skill-row">
            <span>▤</span>
            <div>
              工作区文件<small>可在授权范围内读取</small>
            </div>
          </div>
        </div>
        <div className="automation-tip">
          自动化负责“什么时候做”，Rice 负责“怎么做”。每次任务都会进入 AllRice
          的持久化队列，失败、重试和结果都可以追踪。
        </div>
      </aside>

      {createOpen ? (
        <div
          className="automation-modal-backdrop"
          onClick={() => setCreateOpen(false)}
        >
          <form
            className="automation-modal automation-modal-wide"
            onSubmit={(event) => void createTask(event)}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="automation-modal-heading">
              <div>
                <p className="automation-eyebrow">新建工作流</p>
                <h2>创建自动化</h2>
              </div>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <label>
              任务名称
              <input
                autoFocus
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                placeholder="例如：每天整理项目进展"
              />
            </label>
            <label>
              让 Rice 做什么
              <textarea
                value={draftPrompt}
                onChange={(event) => setDraftPrompt(event.target.value)}
                placeholder="例如：读取工作区最近一周的项目记忆，整理已完成事项、风险和下周计划，并输出一份适合发到群里的简报。"
                rows={5}
              />
            </label>
            <div className="automation-form-grid">
              <label>
                重复周期
                <select
                  value={draftFrequency}
                  onChange={(event) =>
                    setDraftFrequency(event.target.value as Frequency)
                  }
                >
                  <option value="daily">每天</option>
                  <option value="weekly">每周</option>
                </select>
              </label>
              {draftFrequency === 'weekly' ? (
                <label>
                  星期
                  <select
                    value={draftWeekday}
                    onChange={(event) => setDraftWeekday(event.target.value)}
                  >
                    {weekdayLabels.map((label, index) => (
                      <option value={index} key={label}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label>
                执行时间
                <input
                  type="time"
                  value={draftTime}
                  onChange={(event) => setDraftTime(event.target.value)}
                />
              </label>
            </div>
            <label>
              对话创建方式
              <select
                value={draftConversationMode}
                onChange={(event) =>
                  setDraftConversationMode(
                    event.target.value as ConversationMode,
                  )
                }
              >
                <option value="new_each_run">每次执行新建对话（推荐）</option>
                <option value="reuse">延续同一个固定对话</option>
              </select>
              <small className="automation-field-help">
                新建对话更容易追踪每次结果；固定对话适合持续跟进同一个项目。
              </small>
            </label>
            <div className="automation-modal-agent">
              <span>✦</span>
              <div>
                <b>Rice</b>
                <small>复用当前工作区的 AI员工、记忆和已授权技能</small>
              </div>
              {appShell ? (
                <button
                  type="button"
                  onClick={() => appShell.navigate('employees')}
                >
                  配置
                </button>
              ) : (
                <Link href="/employees">配置</Link>
              )}
            </div>
            <button
              className="automation-primary"
              type="submit"
              disabled={busy}
            >
              {busy ? '创建中…' : '创建并启用'}
            </button>
          </form>
        </div>
      ) : null}
    </main>
  );
}
