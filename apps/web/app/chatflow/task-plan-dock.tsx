'use client';

import type { TaskRuntimeTiming } from '@allrice/contracts';
import {
  projectTaskPlan,
  type TaskPlanTranslator,
} from '../../lib/chatflow/task-plan';
import { mergeChatFlowEvents } from '../../lib/chatflow/run-event-buffer';
import { projectPendingUserQuestion } from '../../lib/chatflow/user-question-state';
import { currentAssistantEvents } from '../../lib/execution/assistant-stream';
import type { History, RunTrace, RunView } from './chatflow-types';
import { TodoPanel } from './dsh-upstream/todo/TodoPanel';
import theme from './dsh-upstream/turn-navigation/theme.module.css';

/** Use the selected conversation's latest turn; never fall back to an older plan. */
export function TaskPlanDock({
  sessionId,
  history,
  runViews,
  runTraces,
  runTimings = [],
}: {
  sessionId: string | null;
  history: History | null;
  runViews: Record<string, RunView>;
  runTraces: Record<string, RunTrace>;
  runTimings?: Array<{ runId: string; timing: TaskRuntimeTiming }>;
}) {
  if (!sessionId || history?.session.id !== sessionId) return null;
  const message = history.messages.findLast(
    (item) => item.role === 'assistant',
  );
  if (!message?.runId) return null;
  const runId = message.runId;
  const view = runViews[runId];
  const events = mergeChatFlowEvents(
    runTraces[runId]?.events ?? [],
    view?.events ?? [],
  );
  const todos = projectTaskPlan(events, sessionId, runId);
  if (!todos.length) return null;
  const terminal = currentAssistantEvents(events).some((event) =>
    [
      'run.succeeded',
      'run.failed',
      'run.canceled',
      'run.needs_attention',
    ].includes(event.type),
  );
  const running =
    !terminal &&
    (view
      ? ['running', 'connecting'].includes(view.status)
      : message.status === 'pending');
  const phase = runTimings.find((entry) => entry.runId === runId)?.timing.phase;
  const waiting =
    running &&
    (phase === 'waiting' ||
      phase === 'queued' ||
      !!projectPendingUserQuestion(events));
  const active = running && !waiting && view?.status !== 'connecting';
  const activeLabel = waiting
    ? '等待继续'
    : running && !active
      ? '等待连接'
      : running
        ? '进行中'
        : '未完成';
  const t: TaskPlanTranslator = (key, values) => {
    const labels: Record<string, string> = {
      'todo.title': '任务',
      'todo.progress.done': `${values?.done} 已完成`,
      'todo.progress.active': `${values?.active} ${activeLabel}`,
      'todo.progress.pending': `${values?.pending} ${running ? '待处理' : '未执行'}`,
      'todo.status.completed': '已完成',
      'todo.status.inProgress': activeLabel,
      'todo.status.pending': running ? '待处理' : '未执行',
    };
    return labels[key] ?? key;
  };
  return (
    <div
      className={theme.tokens}
      data-task-plan-state={
        active ? 'running' : waiting ? 'waiting' : 'stopped'
      }
    >
      <TodoPanel
        key={`${sessionId}/${runId}`}
        todos={todos}
        t={t}
        active={active}
      />
    </div>
  );
}
