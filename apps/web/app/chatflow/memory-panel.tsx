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
import {
  employeeMemoryClient,
  MemoryClientError,
  MemoryAccessLost,
  memoryUnknown,
  type MemoryRow,
  type MemoryWriteStore,
} from '../../lib/memory/employee-memory-client';
import { EmployeeMemoryDeleteConfirmation } from './employee-memory-delete-confirmation';
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
  if ([401, 403, 404].includes(response.status)) throw new MemoryAccessLost();
  if (!response.ok) throw Error(memoryUnknown);
  return response.status === 204 ? null : response.json();
}

export function MemoryCard(props: {
  memory: Pick<
    MemoryView,
    | 'id'
    | 'workspaceId'
    | 'ownerId'
    | 'instanceId'
    | 'content'
    | 'revision'
    | 'lifecycleState'
    | 'expiresAt'
    | 'memoryClass'
    | 'sourceType'
    | 'trust'
  > & { ownedByMe?: boolean };
  isOwner?: boolean;
  onEdit?: () => void;
  readOnly?: boolean;
  showRevision?: boolean;
  workspaceId: string;
  scopeId: string;
  headers: Record<string, string>;
  writes: MemoryWriteStore;
  inline: boolean;
  onChange: (action: 'promote' | 'delete') => void;
  onRefresh: () => void;
  onPending: (pending: boolean) => void;
  onAccessLost: () => void;
}) {
  const { memory } = props;
  const ownedByMe = props.isOwner ?? memory.ownedByMe;
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const [deleting, setDeleting] = useState<MemoryRow | null>(null);
  const [error, setError] = useState('');
  const pendingWrite = useRef(false);
  const live = useRef(true);
  const lastMemory = useRef(memory);
  const frozen = useRef<{
    action: 'promote' | 'delete';
    row: MemoryRow;
  } | null>(null);
  const client = useMemo(
    () =>
      employeeMemoryClient(
        {
          scopeId: props.scopeId,
          workspaceId: props.workspaceId,
          instanceId: memory.instanceId!,
          headers: props.headers,
        },
        props.writes,
      ),
    [
      props.scopeId,
      props.workspaceId,
      memory.instanceId,
      props.headers,
      props.writes,
    ],
  );
  useEffect(() => {
    // Accepted reads replace settled rows; pending rows retain their object.
    // Starting or failing a read must leave the operation error visible.
    const refreshed = lastMemory.current !== memory;
    lastMemory.current = memory;
    if (refreshed && !busy) {
      setError('');
      setSettled(false);
    }
  }, [memory, busy]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function snapshot() {
    const row = await client.detail(memory);
    // A stale legacy card may not approve newer, unseen content. The pair is
    // read from the real v2 detail endpoint, never derived from contentDigest.
    if (row.revision !== memory.revision)
      throw new MemoryClientError(
        '记忆已变化，请重新读取后再操作。',
        true,
        'cas_conflict',
      );
    return row;
  }
  async function askDelete() {
    if (pendingWrite.current || settled || !ownedByMe) return;
    pendingWrite.current = true;
    setBusy(true);
    setError('');
    props.onPending(true);
    try {
      const row =
        frozen.current?.action === 'delete'
          ? frozen.current.row
          : await snapshot();
      if (live.current) setDeleting(row);
    } catch (cause) {
      if (live.current && cause instanceof MemoryAccessLost)
        props.onAccessLost();
      if (live.current)
        setError(
          cause instanceof MemoryClientError
            ? cause.message
            : '记忆读取失败，请重试。',
        );
    } finally {
      pendingWrite.current = false;
      props.onPending(false);
      if (live.current) setBusy(false);
    }
  }
  async function mutate(action: 'promote' | 'delete') {
    if (pendingWrite.current || settled || !ownedByMe) return;
    pendingWrite.current = true;
    setBusy(true);
    setError('');
    props.onPending(true);
    let acknowledged = false;
    try {
      const row =
        action === 'delete'
          ? deleting!
          : frozen.current?.action === action
            ? frozen.current.row
            : await snapshot();
      if (!live.current || !row) return;
      frozen.current = { action, row };
      if (action === 'promote') await client.confirm(row);
      else await client.remove(row);
      acknowledged = true;
      frozen.current = null;
      if (live.current) {
        setSettled(true);
        setDeleting(null);
      }
    } catch (cause) {
      if (live.current && cause instanceof MemoryAccessLost)
        props.onAccessLost();
      if (cause instanceof MemoryClientError && cause.definitive)
        frozen.current = null;
      if (live.current)
        setError(
          cause instanceof MemoryClientError ? cause.message : memoryUnknown,
        );
    } finally {
      pendingWrite.current = false;
      props.onPending(false);
      if (live.current) {
        setBusy(false);
        // Fetch after releasing the read-generation guard. A failed refresh
        // does not make an acknowledged operation writable again.
        if (acknowledged) props.onChange(action);
      }
    }
  }
  const candidate = memory.lifecycleState === 'candidate';
  return (
    <article className={css.card} data-memory-id={memory.id} aria-busy={busy}>
      <strong>
        {candidate
          ? memory.expiresAt
            ? '已记为候选，等待你确认'
            : '已记为候选，确认后才生效'
          : '长期记忆'}
      </strong>
      <p className={css.content}>{memory.content}</p>
      <small>
        {memoryClassLabel(memory.memoryClass)} · {memorySourceLabel(memory)}
        {props.showRevision !== false && ` · v${memory.revision}`}
      </small>
      {memory.expiresAt && (
        <p>
          有效期至{' '}
          <time dateTime={memory.expiresAt}>
            {new Date(memory.expiresAt).toLocaleString('zh-CN', {
              timeZoneName: 'short',
            })}
          </time>
          。
        </p>
      )}
      {!props.readOnly && ownedByMe && (candidate || !props.inline) && (
        <div className={css.actions}>
          {props.onEdit && (
            <Button
              type="button"
              variant="outline"
              disabled={busy || settled}
              onClick={props.onEdit}
            >
              编辑
            </Button>
          )}
          {candidate && (
            <Button
              type="button"
              disabled={busy || settled}
              onClick={() => void mutate('promote')}
            >
              确认并记住
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy || settled}
            onClick={() => void askDelete()}
          >
            {candidate ? '放弃' : props.onEdit ? '撤回' : '删除'}
          </Button>
        </div>
      )}
      {error && !deleting && (
        <p role="alert">
          {error}{' '}
          <Button type="button" variant="ghost" onClick={props.onRefresh}>
            重新读取记忆
          </Button>
        </p>
      )}
      <EmployeeMemoryDeleteConfirmation
        memory={deleting}
        busy={busy}
        error={error}
        onCancel={() => {
          if (!pendingWrite.current) {
            setDeleting(null);
            setError('');
          }
        }}
        onDelete={() => void mutate('delete')}
      />
    </article>
  );
}

/** Both hosts read live personal records; no tool output becomes UI authority. */
export function MemoryPanel(props: {
  workspaceId: string;
  scopeId: string;
  headers: Record<string, string>;
  runId?: string;
  instanceId?: string;
  refreshKey?: string;
  writes?: MemoryWriteStore;
}) {
  const inline = !!props.runId;
  const credentials = JSON.stringify(
    Object.entries(props.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  const scope = `${props.scopeId}/${props.workspaceId}/${props.instanceId ?? 'run-bound'}/${props.runId ?? 'personal'}/${credentials}`;
  const active = useRef(scope);
  active.current = scope;
  const pending = useRef(new Set<string>());
  const operationRevision = useRef(0);
  const writes = useRef<MemoryWriteStore>(new Map());
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    memories?: MemoryView[];
    error?: string;
  } | null>(null);
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(credentials)),
    [credentials],
  );
  useEffect(() => {
    operationRevision.current += 1;
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
    const startedOperationRevision = operationRevision.current;
    const current = () =>
      !controller.signal.aborted &&
      active.current === scope &&
      operationRevision.current === startedOperationRevision;
    // A same-scope refresh must not replace cards with a loading screen while
    // another card is still awaiting its mutation acknowledgement.
    setSnapshot((value) => (value?.scope === scope ? value : null));
    const query = new URLSearchParams({
      workspaceId: props.workspaceId,
      personal: '1',
      ...(props.runId ? { runId: props.runId } : {}),
      ...(props.instanceId ? { instanceId: props.instanceId } : {}),
    });
    void fetch('/api/v1/memories?' + query, {
      cache: 'no-store',
      headers,
      signal: controller.signal,
    })
      .then(memoryResponse)
      .then((result) => {
        if (!current()) return;
        const memories = MemoryViewSchema.array().parse(result.memories);
        if (
          memories.some(
            (memory) =>
              memory.workspaceId !== props.workspaceId ||
              !memory.ownedByMe ||
              (props.instanceId !== undefined &&
                memory.instanceId !== props.instanceId),
          )
        )
          throw Error('记忆读取范围已变化，请重新打开。');
        setSnapshot((value) => {
          if (!current()) return value;
          return {
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
          };
        });
      })
      .catch((cause) => {
        if (!current()) return;
        setSnapshot((value) => {
          if (!current()) return value;
          return {
            ...(value?.scope === scope && !(cause instanceof MemoryAccessLost)
              ? value
              : {}),
            scope,
            error: '记忆读取失败，请重新读取。',
          };
        });
      });
    return () => controller.abort();
  }, [
    scope,
    props.workspaceId,
    props.runId,
    props.instanceId,
    props.refreshKey,
    attempt,
    headers,
  ]);
  const current = snapshot?.scope === scope ? snapshot : null;
  const refresh = () => setAttempt((value) => value + 1);
  const cards = (memories: MemoryView[]) =>
    memories.map((memory) => (
      <MemoryCard
        key={`${scope}/${memory.id}`}
        memory={memory}
        workspaceId={props.workspaceId}
        scopeId={props.scopeId}
        headers={headers}
        writes={props.writes ?? writes.current}
        inline={inline}
        onRefresh={refresh}
        onAccessLost={() => {
          if (active.current !== scope) return;
          operationRevision.current += 1;
          setSnapshot({ scope, error: '记忆读取失败，请重新读取。' });
        }}
        onPending={(busy) => {
          if (active.current !== scope) return;
          // A read started before this transition cannot settle this operation.
          operationRevision.current += 1;
          if (busy) pending.current.add(memory.id);
          else pending.current.delete(memory.id);
        }}
        onChange={(action) => {
          if (active.current !== scope) return;
          if (action === 'delete')
            setSnapshot((value) =>
              value?.scope === scope
                ? {
                    scope,
                    memories: value.memories?.filter(
                      (item) => item.id !== memory.id,
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
