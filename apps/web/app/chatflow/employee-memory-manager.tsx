'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import {
  EmployeeMemoryPageSchema,
  EmployeeMemoryTextSchema,
  WorkspaceMemorySchema,
  type EmployeeMemoryPage,
  type ManagedEmployeeMemory,
} from '@allrice/contracts';
import { MemoryCard } from './memory-panel';
import css from './employee-memory-manager.module.css';

export const memoryStateLabels = {
  all: '全部',
  confirmed: '已确认',
  pending: '待确认',
  expired: '已过期',
  archived: '已撤回',
} as const;
type Props = {
  scopeId: string;
  workspaceId: string;
  instanceId: string;
  headers: Record<string, string>;
  employeeName?: string;
  refreshKey?: string;
};

export function EmployeeMemoryManager(props: Props) {
  return (
    <Manager
      key={`${props.scopeId}/${props.workspaceId}/${props.instanceId}`}
      {...props}
    />
  );
}
function Manager(props: Props) {
  const [state, setState] = useState<keyof typeof memoryStateLabels>('all');
  const [cursors, setCursors] = useState<string[]>([]),
    [refresh, setRefresh] = useState(0);
  const [page, setPage] = useState<EmployeeMemoryPage | null>(null),
    [error, setError] = useState(''),
    [readError, setReadError] = useState('');
  const [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<ManagedEmployeeMemory | 'new' | null>(
      null,
    ),
    [text, setText] = useState('');
  const [clearExpiry, setClearExpiry] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const alive = useRef(true),
    generation = useRef(0),
    pending = useRef(new Set<string>());
  const operation = useRef<{ signature: string; key: string } | null>(null);
  const encodedHeaders = JSON.stringify(
    Object.entries(props.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  const headers = useMemo(
    () => Object.fromEntries(JSON.parse(encodedHeaders)),
    [encodedHeaders],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController(),
      started = ++generation.current;
    const query = new URLSearchParams({
      workspaceId: props.workspaceId,
      instanceId: props.instanceId,
      state,
    });
    if (cursors.length) query.set('after', cursors.at(-1)!);
    const current = () =>
      alive.current &&
      !controller.signal.aborted &&
      generation.current === started;
    setReadError('');
    void fetch('/api/v1/memories/manage?' + query, {
      headers,
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw Error('记忆读取失败，请重试。');
        return EmployeeMemoryPageSchema.parse(await response.json());
      })
      .then((value) => {
        if (!current()) return;
        if (
          value.workspaceId !== props.workspaceId ||
          value.instanceId !== props.instanceId
        )
          throw Error('记忆范围已变化，请重新打开。');
        setPage((previous) => ({
          ...value,
          memories: [
            ...value.memories.map((memory) =>
              pending.current.has(memory.id)
                ? (previous?.memories.find((row) => row.id === memory.id) ??
                  memory)
                : memory,
            ),
            ...(previous?.memories ?? []).filter(
              (memory) =>
                pending.current.has(memory.id) &&
                !value.memories.some((row) => row.id === memory.id),
            ),
          ],
        }));
      })
      .catch(() => {
        if (current()) setReadError('记忆读取失败，请重试。');
      });
    return () => controller.abort();
  }, [
    props.workspaceId,
    props.instanceId,
    props.refreshKey,
    state,
    cursors,
    refresh,
    headers,
  ]);
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail?.scopeId === props.scopeId)
        setRefresh((value) => value + 1);
    };
    window.addEventListener('allrice:memory-changed', listener);
    return () => window.removeEventListener('allrice:memory-changed', listener);
  }, [props.scopeId, busy]);
  function changeState(value: typeof state) {
    if (busy || pending.current.size) return;
    setState(value);
    setCursors([]);
    setPage(null);
    setEditor(null);
    setError('');
  }
  function edit(memory: ManagedEmployeeMemory | 'new') {
    setEditor(memory);
    if (
      memory === 'new' ||
      editor === 'new' ||
      !editor ||
      editor.id !== memory.id
    )
      setText(memory === 'new' ? '' : memory.content);
    setClearExpiry(false);
    setError('');
    setNotice('');
  }
  async function mutate(
    action: 'create' | 'edit' | 'promote' | 'archive',
    memory?: ManagedEmployeeMemory,
  ) {
    if (busy) return;
    const content = text.trim();
    if (
      (action === 'create' || action === 'edit') &&
      !EmployeeMemoryTextSchema.safeParse(content).success
    ) {
      setError(
        '请填写记忆，最多 1000 字节。超出时请缩短为习惯、偏好或资料入口。',
      );
      return;
    }
    const body =
      action === 'create'
        ? {
            workspaceId: props.workspaceId,
            instanceId: props.instanceId,
            content,
            sourceType: 'user',
            sourceLabel: '本人新增',
            lifecycleState: 'durable',
            memoryClass: 'user_preference',
          }
        : {
            instanceId: props.instanceId,
            expectedRevision: memory!.revision,
            contentDigest: memory!.contentDigest,
            ...(action === 'edit'
              ? {
                  content,
                  reason: '本人编辑',
                  expiresAt: clearExpiry ? null : memory!.expiresAt,
                }
              : {}),
          };
    const signature = JSON.stringify({ action, id: memory?.id, body });
    if (operation.current?.signature !== signature)
      operation.current = { signature, key: crypto.randomUUID() };
    const key = operation.current.key;
    ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(
        action === 'create'
          ? '/api/v1/memories'
          : `/api/v1/memories/${memory!.id}${action === 'promote' ? '/promote' : ''}?workspaceId=${props.workspaceId}`,
        {
          method:
            action === 'create' || action === 'promote'
              ? 'POST'
              : action === 'edit'
                ? 'PATCH'
                : 'DELETE',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, idempotencyKey: key }),
        },
      );
      if (response.status === 409)
        throw Error(
          '记忆已变化，请重新读取。编辑内容已保留。重新读取后，点该条“编辑”核对最新内容再保存。',
        );
      if (response.status === 422) {
        const result = await response.json();
        if (result.error === 'memory_capacity')
          throw Error(
            `置顶内容超出整条预算，未保存。当前剩余${Number(result.remainingBytes)}字节。请先取消其他置顶或缩短记忆。编辑内容已保留。`,
          );
      }
      if (!response.ok)
        throw Error('暂时无法确认保存结果。请重新读取，编辑内容会保留。');
      if (action === 'archive') {
        if (response.status !== 204)
          throw Error('撤回回执不匹配，请重新读取。');
      } else {
        const { ownedByMe, ...receipt } = (await response.json()).memory;
        if (ownedByMe !== true) throw Error('保存归属不匹配，请重新读取。');
        const saved = WorkspaceMemorySchema.parse(receipt);
        if (
          saved.workspaceId !== props.workspaceId ||
          saved.instanceId !== props.instanceId ||
          (page && saved.ownerId !== page.ownerId) ||
          (memory &&
            (saved.id !== memory.id || saved.ownerId !== memory.ownerId)) ||
          saved.content !==
            (action === 'promote' ? memory!.content : content) ||
          saved.lifecycleState !== 'durable' ||
          saved.trust !== 'user_confirmed'
        )
          throw Error('保存回执不匹配，请重新读取。');
      }
      if (!alive.current) return;
      operation.current = null;
      setEditor(null);
      setNotice(
        action === 'archive'
          ? '已撤回，不再用于后续对话。'
          : action === 'promote'
            ? '已确认这条记忆。'
            : '记忆已保存。',
      );
      setRefresh((value) => value + 1);
      window.dispatchEvent(
        new CustomEvent('allrice:memory-changed', {
          detail: { scopeId: props.scopeId },
        }),
      );
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : '操作失败，请重新读取。',
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function pin(memory: ManagedEmployeeMemory) {
    if (busy || pending.current.size) return;
    const body = {
      instanceId: props.instanceId,
      expectedRevision: memory.revision,
      contentDigest: memory.contentDigest,
      pinned: memory.pinOrder === null,
    };
    const signature = JSON.stringify({ action: 'pin', id: memory.id, body });
    if (operation.current?.signature !== signature)
      operation.current = { signature, key: crypto.randomUUID() };
    ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(
        `/api/v1/memories/${memory.id}/pin?workspaceId=${props.workspaceId}`,
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            ...body,
            idempotencyKey: operation.current.key,
          }),
        },
      );
      if (response.status === 422) {
        const result = await response.json();
        throw Error(
          `置顶内容超出整条预算，未保存。最多20条、6000字节，当前剩余${Number(result.remainingBytes)}字节。请先取消其他置顶或缩短记忆。`,
        );
      }
      if (!response.ok) throw Error('置顶结果未确认，请重新读取后再操作。');
      const saved = WorkspaceMemorySchema.parse((await response.json()).memory);
      if (
        saved.id !== memory.id ||
        saved.ownerId !== memory.ownerId ||
        saved.instanceId !== props.instanceId ||
        saved.workspaceId !== props.workspaceId ||
        saved.revision !== memory.revision + 1 ||
        saved.content !== memory.content
      )
        throw Error('置顶回执不匹配，请重新读取。');
      if (!alive.current) return;
      operation.current = null;
      setNotice(
        body.pinned ? '已置顶，从下一次独立任务优先带入。' : '已取消置顶。',
      );
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : '置顶未确认，请重新读取。',
        );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const bytes = new TextEncoder().encode(text).byteLength;
  return (
    <section className={css.panel} aria-label="个人记忆">
      <header className={css.header}>
        {props.employeeName && (
          <span className={css.avatar} aria-hidden="true">
            {Array.from(props.employeeName)[0]}
          </span>
        )}
        <div className={css.heading}>
          <h3>
            {props.employeeName ? `${props.employeeName} · 记忆` : '记忆'}
          </h3>
          <small>（确认后生效）</small>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => edit('new')}
        >
          ＋ 新增
        </Button>
      </header>
      <p className={css.note}>
        记录习惯、业务偏好和常用资料入口。名字与表达方式仍在员工资料中设置。
      </p>
      <div className={css.tabs} aria-label="记忆状态">
        {Object.entries(memoryStateLabels).map(([value, label]) => (
          <Button
            key={value}
            type="button"
            variant="ghost"
            disabled={busy || pendingCount > 0}
            aria-pressed={state === value}
            onClick={() => changeState(value as typeof state)}
          >
            {label}
          </Button>
        ))}
      </div>
      {page?.budget && (
        <details className={css.budget}>
          <summary>
            容量预览：可容纳 {page.budget.selectedIds.length} /{' '}
            {page.budget.eligibleCount} 条已确认记忆
          </summary>
          <p>
            先按置顶先后，再按最近确认或修改排序，整条保留；最多 20 条、6000
            字节。当前 {page.budget.usedBytes} 字节，未纳入{' '}
            {page.budget.omittedCount}{' '}
            条。预览与下次对话使用相同选择顺序，并预留来源定位信息空间；任务开始时会重新核对资格。
          </p>
        </details>
      )}
      {editor && (
        <form
          className={css.editor}
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              editor === 'new' ? 'create' : 'edit',
              editor === 'new' ? undefined : editor,
            );
          }}
        >
          <label htmlFor={`memory-editor-${props.instanceId}`}>
            {editor === 'new' ? '新增记忆内容' : '编辑记忆内容'}
          </label>
          <textarea
            id={`memory-editor-${props.instanceId}`}
            rows={4}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
          />
          {editor !== 'new' && (
            <p className={css.content}>当前已保存：{editor.content}</p>
          )}
          <small>
            {bytes} / 1000 字节。本人保存后直接确认，无需再次点击确认。
          </small>
          {editor !== 'new' && editor.expiresAt && (
            <label>
              <input
                type="checkbox"
                checked={clearExpiry}
                disabled={busy}
                onChange={(event) => setClearExpiry(event.target.checked)}
              />
              清除这条记忆的有效期
            </label>
          )}
          <div className={css.actions}>
            <Button type="submit" disabled={busy}>
              {busy ? '正在保存…' : '保存记忆'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditor(null)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      {readError && (
        <p role="alert">
          {readError}{' '}
          <Button
            type="button"
            variant="ghost"
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新读取记忆
          </Button>
        </p>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新读取记忆
          </Button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!page && !readError ? (
        <p role="status">正在读取记忆…</p>
      ) : (
        page && (
          <>
            <p className={css.note}>
              {memoryStateLabels[state]} · 共 {page.total} 条
            </p>
            {!page.memories.length && (
              <p>暂无{memoryStateLabels[state]}的记忆。</p>
            )}
            {page.memories.map((memory) => (
              <div key={memory.id}>
                {(memory.state === 'expired' ||
                  memory.state === 'archived') && (
                  <p className={css.note}>
                    {memoryStateLabels[memory.state]} · 不用于后续对话
                  </p>
                )}
                {memory.state === 'confirmed' && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy || pendingCount > 0}
                    aria-pressed={memory.pinOrder !== null}
                    onClick={() => void pin(memory)}
                  >
                    {memory.pinOrder === null ? '置顶' : '取消置顶'}
                  </Button>
                )}
                <MemoryCard
                  memory={memory}
                  isOwner
                  workspaceId={props.workspaceId}
                  headers={headers}
                  inline={false}
                  readOnly={memory.state === 'archived'}
                  showRevision={false}
                  onEdit={() => edit(memory)}
                  onRefresh={() => setRefresh((value) => value + 1)}
                  onPending={(value) => {
                    ++generation.current;
                    if (value) pending.current.add(memory.id);
                    else pending.current.delete(memory.id);
                    setPendingCount(pending.current.size);
                  }}
                  onChange={(updated) => {
                    setPage((previous) =>
                      previous
                        ? {
                            ...previous,
                            memories: previous.memories.flatMap((row) =>
                              row.id === memory.id
                                ? updated
                                  ? [
                                      {
                                        ...row,
                                        content: updated.content,
                                        contentDigest: updated.contentDigest,
                                        revision: updated.revision,
                                        lifecycleState: updated.lifecycleState,
                                        trust: updated.trust,
                                        expiresAt: updated.expiresAt,
                                        updatedAt: updated.updatedAt,
                                        state:
                                          updated.expiresAt &&
                                          Date.parse(updated.expiresAt) <=
                                            Date.now()
                                            ? ('expired' as const)
                                            : ('confirmed' as const),
                                      },
                                    ]
                                  : []
                                : [row],
                            ),
                          }
                        : previous,
                    );
                    window.dispatchEvent(
                      new CustomEvent('allrice:memory-changed', {
                        detail: { scopeId: props.scopeId },
                      }),
                    );
                  }}
                />
              </div>
            ))}
            <div className={css.actions}>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || pendingCount > 0 || !cursors.length}
                onClick={() => {
                  setPage(null);
                  setCursors((value) => value.slice(0, -1));
                }}
              >
                上一页
              </Button>
              <span>第 {cursors.length + 1} 页</span>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || pendingCount > 0 || !page.nextCursor}
                onClick={() => {
                  setPage(null);
                  setCursors((value) => [...value, page.nextCursor!]);
                }}
              >
                下一页
              </Button>
            </div>
          </>
        )
      )}
    </section>
  );
}
