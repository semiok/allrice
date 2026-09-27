'use client';

import { useEffect, useState } from 'react';
import type { SessionReference } from '@allrice/contracts';
import type { Session } from './chatflow-types';
import { DshDialog } from './dsh-upstream/Dialog';
import { readJson } from './chatflow-utils';
import css from './session-reference.module.css';

export function SessionReferencePicker({
  workspaceId,
  activeId,
  headers,
  selected,
  onChange,
  onClose,
}: {
  workspaceId: string;
  activeId: string | null;
  headers: Record<string, string>;
  selected: SessionReference[];
  onChange: (value: SessionReference[]) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Session[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    const timeout = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ workspaceId, q: query });
        if (page) params.set('cursor', page);
        const result = await readJson<{
          sessions: Session[];
          nextCursor: string | null;
        }>(
          await fetch(`/api/v1/sessions?${params}`, {
            headers,
            signal: controller.signal,
            cache: 'no-store',
          }),
        );
        if (controller.signal.aborted) return;
        setRows((current) =>
          page
            ? [
                ...current,
                ...result.sessions.filter(
                  (row) => !current.some((item) => item.id === row.id),
                ),
              ]
            : result.sessions,
        );
        setCursor(result.nextCursor);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '暂时无法加载会话');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [workspaceId, headers, query, page]);
  const visible = rows.filter((row) => row.id !== activeId && !row.archivedAt);
  return (
    <DshDialog
      ariaLabel="引用会话"
      bodyClassName={css.body}
      initialFocusSelector='[aria-label="搜索会话"]'
      title="引用之前的工作"
      eyebrow="会话资料"
      onClose={onClose}
    >
      <p className={css.hint}>
        将所选会话的文字作为这次工作的参考。最多选择 3 段；文件需单独添加。
      </p>
      <input
        autoFocus
        aria-label="搜索会话"
        className={css.search}
        placeholder="搜索会话标题…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setPage(null);
          setRows([]);
        }}
      />
      <div className={css.list} aria-busy={loading}>
        {error && <p role="alert">{error}</p>}
        {visible.map((row) => {
          const checked = selected.some((item) => item.sessionId === row.id);
          return (
            <button
              key={row.id}
              type="button"
              aria-pressed={checked}
              className={css.option}
              disabled={!checked && selected.length >= 3}
              onClick={() =>
                onChange(
                  checked
                    ? selected.filter((item) => item.sessionId !== row.id)
                    : [...selected, { sessionId: row.id, label: row.title }],
                )
              }
            >
              <span className={css.symbol} aria-hidden>
                ＠
              </span>
              <span className={css.title}>
                {row.title}
                <small>
                  {row.visibility === 'private' ? '仅自己可见' : '共享会话'} ·{' '}
                  {new Date(row.updatedAt).toLocaleDateString('zh-CN')}
                </small>
              </span>
              <span aria-hidden>{checked ? '✓' : '＋'}</span>
            </button>
          );
        })}
        {!visible.length && !loading && !error && (
          <p className={css.hint}>
            {query ? '没有找到匹配的会话。' : '暂时没有其他可引用的会话。'}
          </p>
        )}
        {loading && (
          <p className={css.hint} role="status">
            正在加载会话…
          </p>
        )}
        {cursor && !loading && (
          <button
            className={css.more}
            type="button"
            onClick={() => setPage(cursor)}
          >
            加载更多
          </button>
        )}
      </div>
      <div className={css.footer}>
        <span>已选 {selected.length} / 3 段会话</span>
        <button type="button" onClick={onClose}>
          完成
        </button>
      </div>
    </DshDialog>
  );
}

export function SessionReferenceChips({
  references,
  onRemove,
  disabled,
}: {
  references: SessionReference[];
  onRemove?: (id: string) => void;
  disabled?: boolean;
}) {
  if (!references.length) return null;
  return (
    <div className={css.chips} aria-label="引用的会话">
      {references.map((reference) => (
        <span className={css.chip} key={reference.sessionId}>
          <span aria-hidden>＠</span>
          {onRemove ? (
            <span title={reference.label}>{reference.label}</span>
          ) : (
            <a
              href={`/chatflow?session=${reference.sessionId}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`查看引用会话：${reference.label}`}
            >
              {reference.label}
            </a>
          )}
          {onRemove && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除引用：${reference.label}`}
              onClick={() => onRemove(reference.sessionId)}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
