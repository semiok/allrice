'use client';
import { useState } from 'react';
import { EmployeeMemoryPageSchema } from '@allrice/contracts';
import { AdminButton } from '../../components/admin/admin-ui';
import { useAdminRead } from './admin-read';
import { memoryStateLabels } from '../chatflow/employee-memory-manager';
import css from '../chatflow/employee-memory-manager.module.css';

export function EmployeeMemoryView(props: {
  organizationId: string;
  ownerId: string;
  instanceId: string;
}) {
  return (
    <ReadOnlyMemories
      key={`${props.organizationId}/${props.ownerId}/${props.instanceId}`}
      {...props}
    />
  );
}
function ReadOnlyMemories(props: {
  organizationId: string;
  ownerId: string;
  instanceId: string;
}) {
  const [state, setState] =
    useState<keyof typeof memoryStateLabels>('confirmed');
  const [cursors, setCursors] = useState<string[]>([]);
  const params = new URLSearchParams({
    ownerId: props.ownerId,
    instanceId: props.instanceId,
    state,
  });
  if (cursors.length) params.set('after', cursors.at(-1)!);
  const { data, error, refresh } = useAdminRead(
    `/api/v1/admin/organizations/${props.organizationId}/employee-memories?${params}`,
    EmployeeMemoryPageSchema,
  );
  return (
    <section className={css.panel} aria-label="员工记忆只读查看">
      <h4>记忆</h4>
      <p>
        仅供查看，读取已记录审计。无法代本人修改、确认或撤回，也不展示聊天原文。
      </p>
      <div className={css.tabs}>
        {Object.entries(memoryStateLabels).map(([key, label]) => (
          <AdminButton
            key={key}
            aria-pressed={state === key}
            onClick={() => {
              setState(key as typeof state);
              setCursors([]);
            }}
          >
            {label}
          </AdminButton>
        ))}
      </div>
      {error ? (
        <p role="alert">
          {error} <AdminButton onClick={refresh}>重新读取</AdminButton>
        </p>
      ) : !data ? (
        <p role="status">正在读取记忆…</p>
      ) : (
        <>
          <p>
            {memoryStateLabels[state]} · 共 {data.total} 条
          </p>
          {data.memories.map((memory) => (
            <article className={css.card} key={memory.id}>
              <strong>{memoryStateLabels[memory.state]}</strong>
              <p className={css.content}>{memory.content}</p>
              <small>
                更新于 {new Date(memory.updatedAt).toLocaleString()}
                {memory.expiresAt
                  ? ` · 有效期至 ${new Date(memory.expiresAt).toLocaleString()}`
                  : ''}
              </small>
            </article>
          ))}
          {!data.memories.length && <p>暂无此状态的记忆。</p>}
          <div className={css.actions}>
            <AdminButton
              disabled={!cursors.length}
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              上一页记忆
            </AdminButton>
            <span>第 {cursors.length + 1} 页</span>
            <AdminButton
              disabled={!data.nextCursor}
              onClick={() => setCursors((c) => [...c, data.nextCursor!])}
            >
              下一页记忆
            </AdminButton>
          </div>
        </>
      )}
    </section>
  );
}
