'use client';
import { useCallback, useEffect, useState } from 'react';
import {
  EmployeeMemoryDetailResponseSchema,
  EmployeeMemoryListSchema,
} from '@allrice/contracts';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { AdminButton } from '../../components/admin/admin-ui';
import {
  MemoryAccessLost,
  memoryReadFailed,
} from '../../lib/memory/employee-memory-client';
import css from '../chatflow/employee-memory-manager.module.css';

type AdminMemoryScope = {
  organizationId: string;
  ownerId: string;
  instanceId: string;
};

export function EmployeeMemoryView(props: AdminMemoryScope) {
  return (
    <ReadOnlyMemories
      key={`${props.organizationId}/${props.ownerId}/${props.instanceId}`}
      {...props}
    />
  );
}

/** Retain HTTP status here: the general admin helper exposes only a message. */
function useAdminMemoryRead<T>(
  path: string,
  schema: { parse(value: unknown): T },
  onAccessLost: () => void,
) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    path: string;
    data?: T;
    error?: string;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    setResult((previous) => ({
      path,
      data: previous?.path === path ? previous.data : undefined,
    }));
    void (async () => {
      try {
        const response = await fetch(path, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if ([401, 403, 404].includes(response.status))
          throw new MemoryAccessLost();
        if (!response.ok) throw Error(memoryReadFailed);
        const data = schema.parse(await response.json());
        if (!controller.signal.aborted) setResult({ path, data });
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof MemoryAccessLost) onAccessLost();
        else
          setResult((previous) => ({
            path,
            data: previous?.path === path ? previous.data : undefined,
            error: memoryReadFailed,
          }));
      }
    })();
    return () => controller.abort();
  }, [path, schema, attempt, onAccessLost]);
  return {
    data: result?.path === path ? result.data : undefined,
    error: result?.path === path ? result.error : undefined,
    refresh: () => setAttempt((value) => value + 1),
  };
}

function ReadOnlyMemories(props: AdminMemoryScope) {
  const [accessLost, setAccessLost] = useState(false);
  const clearPrivate = useCallback(() => setAccessLost(true), []);
  return (
    <section className={css.panel} aria-label="员工记忆只读查看">
      <h4>记忆</h4>
      <p>
        仅供查看，读取已记录审计。无法代本人修改、确认或撤回，也不展示聊天原文。
      </p>
      {accessLost ? (
        <p role="alert">
          {memoryReadFailed}{' '}
          <AdminButton onClick={() => setAccessLost(false)}>
            重新读取
          </AdminButton>
        </p>
      ) : (
        <ReadableMemories {...props} onAccessLost={clearPrivate} />
      )}
    </section>
  );
}

function ReadableMemories(
  props: AdminMemoryScope & { onAccessLost: () => void },
) {
  const [selected, setSelected] = useState<{
    id: string;
    summary: string;
  } | null>(null);
  // The administrator uses its own audited scope, never the owner endpoint.
  const base = `/api/v1/admin/organizations/${encodeURIComponent(props.organizationId)}/employee-memories`;
  const params = new URLSearchParams({
    ownerId: props.ownerId,
    instanceId: props.instanceId,
  });
  const { data, error, refresh } = useAdminMemoryRead(
    `${base}?${params}`,
    EmployeeMemoryListSchema,
    props.onAccessLost,
  );
  const validData = data?.instanceId === props.instanceId ? data : undefined;
  const readError = error || (data && !validData ? memoryReadFailed : undefined);
  return (
    <>
      {readError && (
        <p role="alert">
          {readError} <AdminButton onClick={refresh}>重新读取</AdminButton>
        </p>
      )}
      {!data && !readError && <p role="status">正在读取记忆…</p>}
      {validData && (
        <>
          {(['pending', 'active'] as const).map((state) => (
            <section
              key={state}
              aria-label={state === 'active' ? '生效中' : '待确认'}
            >
              <h4>
                {state === 'active'
                  ? `生效中 ${validData.counts.active} / 100`
                  : `待确认 ${validData.counts.pending}`}
              </h4>
              {validData[state].map((memory) => (
                <article className={css.card} key={memory.id}>
                  <p className={css.content}>{memory.summary}</p>
                  <small>
                    更新于 {new Date(memory.updatedAt).toLocaleString()}
                  </small>{' '}
                  <AdminButton onClick={() => setSelected(memory)}>
                    查看
                  </AdminButton>
                </article>
              ))}
            </section>
          ))}
          {!validData.counts.active && !validData.counts.pending && (
            <p>还没有记忆</p>
          )}
        </>
      )}
      {selected && (
        <AdminMemoryDetail
          key={selected.id}
          path={`${base}/${encodeURIComponent(selected.id)}?${params}`}
          selected={selected}
          onClose={() => setSelected(null)}
          onAccessLost={props.onAccessLost}
        />
      )}
    </>
  );
}

function AdminMemoryDetail(props: {
  path: string;
  selected: { id: string; summary: string };
  onClose: () => void;
  onAccessLost: () => void;
}) {
  const { data, error, refresh } = useAdminMemoryRead(
    props.path,
    EmployeeMemoryDetailResponseSchema,
    props.onAccessLost,
  );
  const validData = data?.memory.id === props.selected.id ? data : undefined;
  const readError = error || (data && !validData ? memoryReadFailed : undefined);
  return (
    <Modal
      open
      title={props.selected.summary}
      closeLabel="关闭"
      onClose={props.onClose}
    >
      {readError && (
        <p role="alert">
          {readError} <AdminButton onClick={refresh}>重新读取</AdminButton>
        </p>
      )}
      {!data && !readError && <p role="status">正在读取记忆…</p>}
      {validData && (
        <>
          <p>{validData.memory.state === 'active' ? '生效中' : '待确认'}</p>
          <p className={css.content}>
            {validData.memory.details ?? '没有详细说明'}
          </p>
        </>
      )}
    </Modal>
  );
}
