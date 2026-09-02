'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  ManagedBrowserEvidenceArtifact,
  ManagedBrowserTask,
} from '@allrice/contracts';

import {
  hasManagedBrowserEvents,
  safeBrowserHost,
} from '../../lib/chatflow/managed-browser-task-presenter';

import styles from './dsh-saas.module.css';

interface ManagedBrowserTaskPanelProps {
  runId: string;
  workspaceId: string;
  tenantHeaders: Record<string, string>;
  runActive: boolean;
}

type TaskResponse = { tasks: ManagedBrowserTask[] };

async function readJson<T>(response: Response): Promise<T> {
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

export { hasManagedBrowserEvents };

function statusLabel(status: ManagedBrowserTask['status']) {
  return (
    {
      queued: '等待执行',
      running: '浏览中',
      succeeded: '已完成',
      failed: '未完成',
      canceled: '已取消',
    } satisfies Record<ManagedBrowserTask['status'], string>
  )[status];
}

function evidenceKindLabel(kind: string) {
  return (
    (
      {
        navigation: '访问页面',
        interaction: '页面操作',
        capture: '保存证据',
        download: '保存下载',
      } as Record<string, string>
    )[kind] ?? '浏览记录'
  );
}

function artifactKindLabel(kind: ManagedBrowserEvidenceArtifact['kind']) {
  return (
    {
      content: '页面快照',
      screenshot: '页面截图',
      download: '下载文件',
    } satisfies Record<ManagedBrowserEvidenceArtifact['kind'], string>
  )[kind];
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.ceil(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function taskFailureLabel(task: ManagedBrowserTask) {
  if (task.status === 'canceled') return '任务已按你的要求停止。';
  if (task.status !== 'failed') return null;
  if (task.errorCode === 'BROWSER_TARGET_TIMEOUT') {
    return '浏览任务超过执行时限。';
  }
  if (task.errorCode === 'BROWSER_TARGET_BUSY') {
    return '云端浏览器当前任务已满。';
  }
  return '浏览任务未能完成。';
}

export function ManagedBrowserTaskPanel({
  runId,
  workspaceId,
  tenantHeaders,
  runActive,
}: ManagedBrowserTaskPanelProps) {
  const [tasks, setTasks] = useState<ManagedBrowserTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const [artifactBusyId, setArtifactBusyId] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const result = await readJson<TaskResponse>(
        await fetch(
          `/api/v1/managed-browser-tasks?workspaceId=${encodeURIComponent(workspaceId)}&runId=${encodeURIComponent(runId)}&limit=20`,
          {
            cache: 'no-store',
            headers: tenantHeaders,
          },
        ),
      );
      setTasks(result.tasks);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '浏览任务加载失败');
    } finally {
      setLoading(false);
    }
  }, [runId, tenantHeaders, workspaceId]);

  const hasActiveTask = tasks.some((task) =>
    ['queued', 'running'].includes(task.status),
  );

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (!runActive && !hasActiveTask) return;
    const timer = window.setInterval(() => void loadTasks(), 1_500);
    return () => window.clearInterval(timer);
  }, [hasActiveTask, loadTasks, runActive]);

  const cancelTask = useCallback(
    async (task: ManagedBrowserTask) => {
      setCancelingId(task.id);
      setError('');
      try {
        await readJson(
          await fetch(
            `/api/v1/managed-browser-tasks/${task.id}/cancel?workspaceId=${encodeURIComponent(workspaceId)}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...tenantHeaders,
              },
              body: JSON.stringify({ reason: 'user_requested' }),
            },
          ),
        );
        await loadTasks();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '停止浏览任务失败');
      } finally {
        setCancelingId(null);
      }
    },
    [loadTasks, tenantHeaders, workspaceId],
  );

  const openArtifact = useCallback(
    async (
      artifact: ManagedBrowserEvidenceArtifact,
      disposition: 'view' | 'download',
    ) => {
      setArtifactBusyId(artifact.id);
      setError('');
      try {
        const signed = await readJson<{ url: string }>(
          await fetch(`/api/v1/files/${artifact.objectId}/sign`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...tenantHeaders,
            },
            body: JSON.stringify({ lifetimeSeconds: 900 }),
          }),
        );
        const anchor = document.createElement('a');
        anchor.href = signed.url;
        if (disposition === 'download') {
          anchor.download = artifact.name;
        } else {
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
        }
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '证据文件打开失败');
      } finally {
        setArtifactBusyId(null);
      }
    },
    [tenantHeaders],
  );

  const orderedTasks = useMemo(
    () => [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [tasks],
  );

  if (loading && tasks.length === 0) {
    return <div className={styles.browserTaskLoading}>正在读取浏览任务…</div>;
  }

  if (!orderedTasks.length && !error) return null;

  return (
    <section className={styles.browserTasks} aria-label="云端浏览器任务">
      <div className={styles.browserTasksHeader}>
        <strong>云端浏览器</strong>
        <button onClick={() => void loadTasks()} type="button">
          刷新
        </button>
      </div>
      {error ? <p className={styles.browserTaskError}>{error}</p> : null}
      {orderedTasks.map((task) => {
        const host =
          safeBrowserHost(task.evidence.at(-1)?.url) ??
          safeBrowserHost(task.startUrl) ??
          '公开网页';
        const events = task.evidence
          .flatMap((capture) => capture.events)
          .sort((a, b) => a.sequence - b.sequence);
        const failure = taskFailureLabel(task);
        const active = ['queued', 'running'].includes(task.status);
        return (
          <details
            className={styles.browserTask}
            data-status={task.status}
            open={active || undefined}
            key={`${task.id}:${task.status}`}
          >
            <summary>
              <span className={styles.browserTaskStatus} aria-hidden="true" />
              <span>
                <strong>{host}</strong>
                <small>
                  {statusLabel(task.status)} · {formatTime(task.createdAt)}
                </small>
              </span>
              <span className={styles.browserTaskSummaryMeta}>
                {task.artifacts.length
                  ? `${task.artifacts.length} 份证据`
                  : '查看详情'}
              </span>
            </summary>
            <div className={styles.browserTaskBody}>
              {events.length ? (
                <ol className={styles.browserEvidenceTimeline}>
                  {events.map((event, index) => (
                    <li
                      data-status={event.status}
                      key={`${event.sequence}:${index}`}
                    >
                      <span aria-hidden="true" />
                      <div>
                        <strong>{evidenceKindLabel(event.kind)}</strong>
                        <small>{event.summary}</small>
                        <time>{formatTime(event.occurredAt)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              ) : active ? (
                <p className={styles.browserTaskEmpty}>
                  正在等待浏览器返回进度…
                </p>
              ) : null}

              {task.artifacts.length ? (
                <div className={styles.browserArtifacts}>
                  {task.artifacts.map((artifact) => (
                    <div key={artifact.id}>
                      <span>
                        <strong>{artifactKindLabel(artifact.kind)}</strong>
                        <small>
                          {formatBytes(artifact.sizeBytes)} · 已保存校验证据
                        </small>
                      </span>
                      <span className={styles.browserArtifactActions}>
                        <button
                          disabled={artifactBusyId === artifact.id}
                          onClick={() => void openArtifact(artifact, 'view')}
                          type="button"
                        >
                          查看
                        </button>
                        <button
                          disabled={artifactBusyId === artifact.id}
                          onClick={() =>
                            void openArtifact(artifact, 'download')
                          }
                          type="button"
                        >
                          下载
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}

              {failure ? (
                <p className={styles.browserTaskFailure}>{failure}</p>
              ) : null}
              {active ? (
                <button
                  className={styles.browserTaskCancel}
                  disabled={cancelingId === task.id}
                  onClick={() => void cancelTask(task)}
                  type="button"
                >
                  {cancelingId === task.id ? '正在停止…' : '停止浏览任务'}
                </button>
              ) : null}
            </div>
          </details>
        );
      })}
    </section>
  );
}
