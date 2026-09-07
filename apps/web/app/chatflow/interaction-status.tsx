'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import {
  InteractionStatusSchema as schema,
  type InteractionStatus,
} from '@allrice/contracts';
import styles from './workbench.module.css';

export function useInteractionStatus(
  enabled: boolean,
  sessionId: string | null,
  workspaceId: string | undefined,
  headers: Record<string, string>,
) {
  const [value, setValue] = useState<{
      scope: string;
      data: InteractionStatus;
    } | null>(null),
    [error, setError] = useState('');
  const scope = `${workspaceId}/${sessionId}`;
  const generation = useRef(0);
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!enabled || !sessionId || !workspaceId) return;
      const requestGeneration = ++generation.current;
      try {
        const response = await fetch(
          `/api/v1/sessions/${sessionId}/interactions?workspaceId=${workspaceId}`,
          { headers, cache: 'no-store', signal },
        );
        if (!response.ok) throw new Error('交互状态暂不可用');
        const data = schema.parse(await response.json());
        if (!signal?.aborted && requestGeneration === generation.current) {
          setValue({ scope, data });
          setError('');
        }
      } catch (e) {
        if (!signal?.aborted && requestGeneration === generation.current) {
          setValue(null);
          setError(e instanceof Error ? e.message : '状态不可用');
        }
      }
    },
    [enabled, sessionId, workspaceId, headers, scope],
  );
  useEffect(() => {
    const abort = new AbortController();
    void reload(abort.signal);
    const timer = setInterval(() => void reload(abort.signal), 2000);
    return () => {
      generation.current++;
      abort.abort();
      clearInterval(timer);
    };
  }, [reload]);
  return { data: value?.scope === scope ? value.data : null, error, reload };
}
const labels: Record<string, string> = {
  message: '普通消息',
  steer_current: '本轮纠偏',
  queue_next: '下一轮任务',
  ask_user: '问题回答',
  plan_review: '计划认可',
  version_feedback: '版本修订',
};
const states: Record<string, string> = {
  adopted: '已进入原回合步骤',
  unknown: '结果待核实 · 不自动重放',
  rejected: '未生效／已失效',
  pending: '已收到 · 等待执行步骤接收',
  received: '已收到 · 待创建任务',
  queued: '已排队',
  running: '任务执行中',
  completed: '任务已完成',
  canceled: '已取消',
  failed: '执行失败',
};
export function InteractionStatusPanel({
  data,
  error,
  sessionId,
  onArtifact,
}: {
  data: InteractionStatus | null;
  error: string;
  sessionId: string;
  onArtifact: (id: string) => void;
}) {
  const waiting =
    (data?.inputs.filter((i) =>
      ['pending', 'unknown', 'received', 'queued'].includes(i.status),
    ).length ?? 0) + (data?.pendingActions.length ?? 0);
  return (
    <details className={styles.history} aria-label="交互与任务记录">
      <summary>
        交互与任务记录{waiting ? ` · ${waiting} 项等待处理` : ''}
      </summary>
      {error ? <p role="status">{error}</p> : null}
      <p>
        任务、执行步骤、命令进程各有独立状态；助手尚未发布。认可计划或提交意见不授予执行权限。
      </p>
      {data?.runtime ? (
        <p>
          当前配置：{data.runtime.currentVersionId?.slice(0, 8) ?? '暂无运行'}
          ；下一次任务配置：
          {data.runtime.nextVersionId?.slice(0, 8) ?? '未配置'}。
          {data.runtime.currentVersionId &&
          data.runtime.currentVersionId !== data.runtime.nextVersionId
            ? '已发布的新配置不会改变正在执行的任务。'
            : ''}
        </p>
      ) : null}
      {data?.pendingActions.length ? (
        <section aria-label="待批准动作">
          <strong>待批准动作</strong>
          <ul>
            {data.pendingActions.map((a) => (
              <li key={a.approvalId}>
                <a href={`?session=${sessionId}#operation-${a.operationId}`}>
                  查看精确动作与批准／拒绝
                </a>
                <small>
                  {' '}
                  · {new Date(a.expiresAt).toLocaleTimeString()} 前有效
                </small>
              </li>
            ))}
          </ul>
          <p>只在对应动作卡片批准，不会通过聊天或计划认可代替授权。</p>
        </section>
      ) : null}
      <ol>
        {data?.inputs.map((i) => (
          <li key={i.inputId} id={`input-${i.inputId}`}>
            <strong>
              {labels[i.kind] ?? '输入'} · {states[i.status]}
            </strong>
            <small> {new Date(i.createdAt).toLocaleTimeString()}</small>
            {i.evidence ? (
              <small>
                {' '}
                · 原生日志 #{i.evidence.sequence}
                {i.evidence.checkpoint === 'question_resolved'
                  ? '：表单已交回工具'
                  : '：进入步骤上下文'}
              </small>
            ) : null}{' '}
            <a href={`?session=${sessionId}#message-${i.messageId}`}>
              定位输入
            </a>
            {i.artifactId ? (
              <button type="button" onClick={() => onArtifact(i.artifactId!)}>
                审查对应版本
              </button>
            ) : null}
          </li>
        ))}
      </ol>
      <small>
        最近 30
        次提交；历史对话保留完整内容。没有原生用量时显示“未知”，不按零消耗计。
      </small>
    </details>
  );
}
