'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  EmployeeMemoryRowSchema,
  UuidSchema,
  type ChatFlowEventEnvelope,
  type EmployeeMemoryRecord,
} from '@allrice/contracts';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { z } from 'zod';
import {
  employeeMemoryClient,
  MemoryClientError,
  MemoryAccessLost,
  memoryUnknown,
  type MemoryRow,
  type MemoryWriteStore,
} from '../../lib/memory/employee-memory-client';
import { EmployeeMemoryDeleteConfirmation } from './employee-memory-delete-confirmation';
import { MemoryWriteReceipt } from './memory-write-receipt';
import receiptCss from './memory-write-receipt.module.css';
import css from './memory-panel.module.css';

const MemoryViewSchema = EmployeeMemoryRowSchema.extend({
  workspaceId: UuidSchema,
  ownerId: UuidSchema,
  instanceId: UuidSchema,
  ownedByMe: z.boolean(),
}).strict();
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
  memory: MemoryView;
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
  const [uncertain, setUncertain] = useState(false);
  const [completePair, setCompletePair] = useState<EmployeeMemoryRecord | null>(
    null,
  );
  const pendingWrite = useRef(false);
  const live = useRef(true);
  const onAccessLost = useRef(props.onAccessLost);
  onAccessLost.current = props.onAccessLost;
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
          instanceId: memory.instanceId,
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
  const visiblePair =
    completePair?.revision === memory.revision &&
    completePair.pairDigest === memory.pairDigest
      ? completePair
      : null;
  useEffect(() => {
    const controller = new AbortController();
    setCompletePair(null);
    if (!memory.hasDetails) return () => controller.abort();
    void client
      .detail(memory, controller.signal)
      .then((row) => {
        if (controller.signal.aborted) return;
        if (
          row.revision !== memory.revision ||
          row.pairDigest !== memory.pairDigest
        )
          throw new MemoryClientError(
            '记忆已变化，请重新读取后再操作。',
            true,
            'cas_conflict',
          );
        setCompletePair(row);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof MemoryAccessLost) onAccessLost.current();
        setError(
          cause instanceof MemoryClientError
            ? cause.message
            : '记忆读取失败，请重试。',
        );
      });
    return () => controller.abort();
  }, [client, memory]);
  async function snapshot() {
    const row = await client.detail(memory);
    // Confirm only the exact complete pair this current card represents.
    if (
      row.revision !== memory.revision ||
      row.pairDigest !== memory.pairDigest
    )
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
    setUncertain(false);
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
    if (
      pendingWrite.current ||
      settled ||
      !ownedByMe ||
      (action === 'promote' && memory.hasDetails && !visiblePair)
    )
      return;
    pendingWrite.current = true;
    setBusy(true);
    setError('');
    setUncertain(false);
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
      if (live.current) {
        setUncertain(!(cause instanceof MemoryClientError && cause.definitive));
        setError(
          cause instanceof MemoryClientError ? cause.message : memoryUnknown,
        );
      }
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
  const candidate = memory.state === 'pending';
  const deleteConfirmation = (
    <EmployeeMemoryDeleteConfirmation
      memory={deleting}
      busy={busy}
      error={error}
      onCancel={() => {
        if (!pendingWrite.current) {
          setDeleting(null);
          if (!props.inline) setError('');
        }
      }}
      onDelete={() => void mutate('delete')}
    />
  );
  if (props.inline)
    return (
      <MemoryWriteReceipt
        id={memory.id}
        phase={
          busy
            ? 'confirming'
            : error
              ? uncertain
                ? 'unknown'
                : 'failed'
              : !candidate || settled
                ? 'remembered'
                : 'candidate'
        }
        content={
          visiblePair?.details == null
            ? memory.summary
            : `${memory.summary}\n${visiblePair.details}`
        }
        error={error}
        canWrite={!props.readOnly && ownedByMe}
        canConfirm={!settled && (!memory.hasDetails || !!visiblePair)}
        onConfirm={() => void mutate('promote')}
        onDelete={() => void askDelete()}
        onRefresh={props.onRefresh}
      >
        {deleteConfirmation}
      </MemoryWriteReceipt>
    );
  return (
    <article className={css.card} data-memory-id={memory.id} aria-busy={busy}>
      <strong>{candidate ? '已记为候选，确认后才生效' : '长期记忆'}</strong>
      <p className={css.content}>
        {visiblePair?.details === null || !visiblePair
          ? memory.summary
          : `${memory.summary}\n${visiblePair.details}`}
      </p>
      {props.showRevision !== false && <small>v{memory.revision}</small>}
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
              disabled={busy || settled || (memory.hasDetails && !visiblePair)}
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
      {deleteConfirmation}
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
  // An acknowledged discard has no record to fetch. Keep only its ID in this
  // mounted scope, never deleted content or a new persisted memory state.
  const [discarded, setDiscarded] = useState<{
    scope: string;
    ids: string[];
  } | null>(null);
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
        if (cause instanceof MemoryAccessLost) setDiscarded(null);
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
          setDiscarded(null);
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
          if (action === 'delete') {
            if (inline)
              setDiscarded((value) => ({
                scope,
                ids: [
                  ...new Set([
                    ...(value?.scope === scope ? value.ids : []),
                    memory.id,
                  ]),
                ],
              }));
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
          }
          window.dispatchEvent(
            new CustomEvent(changedEvent, {
              detail: { scopeId: props.scopeId },
            }),
          );
        }}
      />
    ));
  const discardedIds = discarded?.scope === scope ? discarded.ids : [];
  if (
    inline &&
    current?.memories?.length === 0 &&
    !current.error &&
    !discardedIds.length
  )
    return null;
  return (
    <section
      className={inline ? receiptCss.panel : css.panel}
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
          {(['pending', 'active'] as const).map((state) => {
            const group = current.memories!.filter(
              (memory) => memory.state === state,
            );
            return (
              <section
                key={state}
                aria-label={state === 'pending' ? '待你确认' : '长期记忆'}
              >
                <h4>{state === 'pending' ? '待你确认' : '长期记忆'}</h4>
                {group.length ? (
                  cards(group)
                ) : (
                  <p>
                    {state === 'pending'
                      ? '暂无待确认的记忆。'
                      : '暂无长期记忆。'}
                  </p>
                )}
              </section>
            );
          })}
        </>
      )}
      {inline &&
        discardedIds.map((id) => (
          <MemoryWriteReceipt key={id} id={id} phase="discarded" />
        ))}
    </section>
  );
}
