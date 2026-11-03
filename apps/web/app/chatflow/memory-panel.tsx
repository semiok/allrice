'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  WorkspaceMemorySchema,
  type ChatFlowEventEnvelope,
} from '@allrice/contracts';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { z } from 'zod';
import {
  memoryClassLabel,
  memorySourceLabel,
} from '../../lib/memory/presenter';
import css from './memory-panel.module.css';

const MemoryViewSchema = WorkspaceMemorySchema.extend({
  ownedByMe: z.boolean(),
});
type MemoryView = z.infer<typeof MemoryViewSchema>;
const changedEvent = 'allrice:memory-changed';

/** Protocol completion is a read hint, never permission or a memory receipt. */
export function memoryReadRevision(events: ChatFlowEventEnvelope[]) {
  return [
    ...new Set(
      events
        .filter(
          (event) =>
            event.type === 'tool.completed' &&
            ['workspace.memory.remember', 'workspace_memory_remember'].includes(
              String(event.payload.name),
            ),
        )
        .map((event) => String(event.payload.toolCallId ?? event.eventId)),
    ),
  ]
    .sort()
    .join(',');
}

async function memoryResponse(response: Response) {
  if (!response.ok) throw Error('暂时无法确认操作结果，请重新读取记忆。');
  return response.status === 204 ? null : response.json();
}

function MemoryCard(props: {
  memory: MemoryView;
  workspaceId: string;
  headers: Record<string, string>;
  inline: boolean;
  onChange: (memory: MemoryView | null) => void;
  onRefresh: () => void;
  onPending: (pending: boolean) => void;
}) {
  const { memory } = props;
  const [busy, setBusy] = useState<'promote' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const live = useRef(true);
  const lastMemory = useRef(memory);
  useEffect(() => {
    // Successful reads replace settled rows; pending rows retain their object.
    // Starting or failing a read must leave the operation error visible.
    const refreshed = lastMemory.current !== memory;
    lastMemory.current = memory;
    if (refreshed && !busy) setError('');
  }, [memory, busy]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function mutate(action: 'promote' | 'delete') {
    if (busy || !memory.ownedByMe) return;
    setBusy(action);
    setError('');
    props.onPending(true);
    try {
      const response = await fetch(
        `/api/v1/memories/${encodeURIComponent(memory.id)}${action === 'promote' ? '/promote' : ''}?workspaceId=${encodeURIComponent(props.workspaceId)}`,
        {
          method: action === 'promote' ? 'POST' : 'DELETE',
          headers: props.headers,
        },
      );
      const result = await memoryResponse(response);
      if (action === 'delete' && response.status !== 204)
        throw Error('暂时无法确认操作结果，请重新读取记忆。');
      const updated =
        action === 'promote' ? MemoryViewSchema.parse(result.memory) : null;
      if (
        updated &&
        (updated.id !== memory.id ||
          updated.workspaceId !== props.workspaceId ||
          updated.ownerId !== memory.ownerId ||
          !updated.ownedByMe ||
          updated.lifecycleState !== 'durable')
      )
        throw Error('记忆确认回执不匹配，请重新读取。');
      if (live.current) props.onChange(updated);
    } catch {
      if (live.current) setError('暂时无法确认操作结果，请重新读取记忆。');
    } finally {
      props.onPending(false);
      if (live.current) setBusy(null);
    }
  }
  const candidate = memory.lifecycleState === 'candidate';
  return (
    <article
      className={css.card}
      data-memory-id={memory.id}
      aria-busy={busy !== null}
    >
      <strong>
        {candidate
          ? memory.expiresAt
            ? '已记为候选，等待你确认'
            : '已记为候选，确认后才生效'
          : '长期记忆'}
      </strong>
      <p className={css.content}>{memory.content}</p>
      <small>
        {memoryClassLabel(memory.memoryClass)} · {memorySourceLabel(memory)} · v
        {memory.revision}
      </small>
      {memory.expiresAt && (
        <p>
          有效期至{' '}
          <time dateTime={memory.expiresAt}>
            {new Date(memory.expiresAt).toLocaleString('zh-CN', {
              timeZoneName: 'short',
            })}
          </time>
          。 确认不会延长有效期；过期后不会用于后续对话。
        </p>
      )}
      {memory.ownedByMe && (candidate || !props.inline) && (
        <div className={css.actions}>
          {candidate && (
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void mutate('promote')}
            >
              {busy === 'promote' ? '正在确认…' : '确认并记住'}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void mutate('delete')}
          >
            {busy === 'delete' ? '正在处理…' : candidate ? '放弃' : '删除'}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <Button type="button" variant="ghost" onClick={props.onRefresh}>
            重新读取记忆
          </Button>
        </p>
      )}
    </article>
  );
}

/** Both hosts read live personal records; no tool output becomes UI authority. */
export function MemoryPanel(props: {
  workspaceId: string;
  scopeId: string;
  headers: Record<string, string>;
  runId?: string;
  refreshKey?: string;
}) {
  const inline = !!props.runId;
  const scope = `${props.scopeId}/${props.workspaceId}/${props.runId ?? 'personal'}`;
  const active = useRef(scope);
  active.current = scope;
  const pending = useRef(new Set<string>());
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    memories?: MemoryView[];
    error?: string;
  } | null>(null);
  const credentials = JSON.stringify(
    Object.entries(props.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(credentials)),
    [credentials],
  );
  useEffect(() => {
    pending.current.clear();
  }, [scope]);
  useEffect(() => {
    const reload = (event: Event) => {
      if ((event as CustomEvent).detail?.scopeId === props.scopeId)
        setAttempt((value) => value + 1);
    };
    window.addEventListener(changedEvent, reload);
    return () => window.removeEventListener(changedEvent, reload);
  }, [props.scopeId]);
  useEffect(() => {
    const controller = new AbortController();
    // A same-scope refresh must not replace cards with a loading screen while
    // another card is still awaiting its mutation acknowledgement.
    setSnapshot((value) => (value?.scope === scope ? value : null));
    const query = new URLSearchParams({
      workspaceId: props.workspaceId,
      personal: '1',
      ...(props.runId ? { runId: props.runId } : {}),
    });
    void fetch('/api/v1/memories?' + query, {
      cache: 'no-store',
      headers,
      signal: controller.signal,
    })
      .then(memoryResponse)
      .then((result) => {
        const memories = MemoryViewSchema.array().parse(result.memories);
        if (
          memories.some(
            (memory) =>
              memory.workspaceId !== props.workspaceId || !memory.ownedByMe,
          )
        )
          throw Error('记忆读取范围已变化，请重新打开。');
        if (!controller.signal.aborted && active.current === scope)
          setSnapshot((value) => ({
            scope,
            memories: [
              ...memories.map((memory) =>
                pending.current.has(memory.id) && value?.scope === scope
                  ? (value.memories?.find((item) => item.id === memory.id) ??
                    memory)
                  : memory,
              ),
              ...(value?.scope === scope ? (value.memories ?? []) : []).filter(
                (memory) =>
                  pending.current.has(memory.id) &&
                  !memories.some((item) => item.id === memory.id),
              ),
            ],
          }));
      })
      .catch(() => {
        if (!controller.signal.aborted && active.current === scope)
          setSnapshot((value) => ({
            ...(value?.scope === scope ? value : {}),
            scope,
            error: '记忆读取失败，请重新读取。',
          }));
      });
    return () => controller.abort();
  }, [
    scope,
    props.workspaceId,
    props.runId,
    props.refreshKey,
    attempt,
    headers,
  ]);
  const current = snapshot?.scope === scope ? snapshot : null;
  const refresh = () => setAttempt((value) => value + 1);
  const cards = (memories: MemoryView[]) =>
    memories.map((memory) => (
      <MemoryCard
        key={memory.id}
        memory={memory}
        workspaceId={props.workspaceId}
        headers={headers}
        inline={inline}
        onRefresh={refresh}
        onPending={(busy) => {
          if (active.current !== scope) return;
          if (busy) pending.current.add(memory.id);
          else pending.current.delete(memory.id);
        }}
        onChange={(updated) => {
          if (active.current !== scope) return;
          setSnapshot((value) =>
            value?.scope === scope
              ? {
                  scope,
                  memories: value.memories?.flatMap((item) =>
                    item.id === memory.id ? (updated ? [updated] : []) : [item],
                  ),
                }
              : value,
          );
          window.dispatchEvent(
            new CustomEvent(changedEvent, {
              detail: { scopeId: props.scopeId },
            }),
          );
        }}
      />
    ));
  if (inline && current?.memories?.length === 0 && !current.error) return null;
  return (
    <section
      className={css.panel}
      aria-label={inline ? '本次记忆回执' : '个人记忆'}
    >
      {!inline && (
        <>
          <h3>个人记忆</h3>
          <p>
            AllRice
            助手保存的候选需要你确认，才会用于后续相关对话。显示当前工作区最近
            100 条个人记忆。
          </p>
        </>
      )}
      {current?.error && (
        <p role="alert">
          {current.error}{' '}
          <Button type="button" variant="ghost" onClick={refresh}>
            重新读取记忆
          </Button>
        </p>
      )}
      {!current?.memories ? (
        !current?.error && <p role="status">正在读取记忆…</p>
      ) : inline ? (
        cards(current.memories)
      ) : (
        <>
          {(['candidate', 'durable'] as const).map((state) => {
            const group = current.memories!.filter(
              (memory) => memory.lifecycleState === state,
            );
            return (
              <section
                key={state}
                aria-label={state === 'candidate' ? '待你确认' : '长期记忆'}
              >
                <h4>{state === 'candidate' ? '待你确认' : '长期记忆'}</h4>
                {group.length ? (
                  cards(group)
                ) : (
                  <p>
                    {state === 'candidate'
                      ? '暂无待确认的记忆。'
                      : '暂无长期记忆。'}
                  </p>
                )}
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}
