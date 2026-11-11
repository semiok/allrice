'use client';
import { useState } from 'react';
import { EmployeeMemoryDetailResponseSchema, EmployeeMemoryListSchema } from '@allrice/contracts';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { AdminButton } from '../../components/admin/admin-ui';
import { useAdminRead } from './admin-read';
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
  const [selected, setSelected] = useState<{ id: string; summary: string } | null>(null);
  // The administrator uses its own audited scope, never the owner endpoint.
  const base = `/api/v1/admin/organizations/${encodeURIComponent(props.organizationId)}/employee-memories`;
  const params = new URLSearchParams({
    ownerId: props.ownerId,
    instanceId: props.instanceId,
  });
  const { data, error, refresh } = useAdminRead(
    `${base}?${params}`,
    EmployeeMemoryListSchema,
  );
  const readError = error || (data && data.instanceId !== props.instanceId ? '记忆读取失败，请重试。' : undefined);
  return (
    <section className={css.panel} aria-label="员工记忆只读查看">
      <h4>记忆</h4>
      <p>
        仅供查看，读取已记录审计。无法代本人修改、确认或撤回，也不展示聊天原文。
      </p>
      {readError ? (
        <p role="alert">
          {readError} <AdminButton onClick={refresh}>重新读取</AdminButton>
        </p>
      ) : !data ? (
        <p role="status">正在读取记忆…</p>
      ) : (
        <>
          {(['pending', 'active'] as const).map((state) => (
            <section key={state} aria-label={state === 'active' ? '生效中' : '待确认'}>
              <h4>{state === 'active' ? `生效中 ${data.counts.active} / 100` : `待确认 ${data.counts.pending}`}</h4>
              {data[state].map((memory) => (
                <article className={css.card} key={memory.id}>
                  <p className={css.content}>{memory.summary}</p>
                  <small>更新于 {new Date(memory.updatedAt).toLocaleString()}</small>{' '}
                  <AdminButton onClick={() => setSelected(memory)}>查看</AdminButton>
                </article>
              ))}
            </section>
          ))}
          {!data.counts.active && !data.counts.pending && <p>还没有记忆</p>}
        </>
      )}
      {selected && (
        <AdminMemoryDetail
          key={selected.id}
          path={`${base}/${encodeURIComponent(selected.id)}?${params}`}
          selected={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function AdminMemoryDetail(props: {
  path: string;
  selected: { id: string; summary: string };
  onClose: () => void;
}) {
  const { data, error, refresh } = useAdminRead(props.path, EmployeeMemoryDetailResponseSchema);
  const readError = error || (data && data.memory.id !== props.selected.id ? '记忆读取失败，请重试。' : undefined);
  return (
    <Modal open title={props.selected.summary} closeLabel="关闭" onClose={props.onClose}>
      {readError ? (
        <p role="alert">{readError} <AdminButton onClick={refresh}>重新读取</AdminButton></p>
      ) : !data ? <p role="status">正在读取记忆…</p> : (
        <>
          <p>{data.memory.state === 'active' ? '生效中' : '待确认'}</p>
          <p className={css.content}>{data.memory.details ?? '没有详细说明'}</p>
        </>
      )}
    </Modal>
  );
}
