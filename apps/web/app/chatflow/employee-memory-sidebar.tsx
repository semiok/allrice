'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './employee-memory-sidebar.module.css';

/** Presentation models only. These are not a memory HTTP/DB contract.
 * A future authorized adapter must supply the complete scoped collection and
 * validate real operation receipts before resolving any action. The legacy
 * content/page DTO is deliberately not adapted or mounted here. */
export type MemorySidebarRow = {
  id: string;
  summary: string;
  state: 'active' | 'pending';
  capturedAt: string;
  updatedAt: string;
};
export type MemorySidebarDetail = MemorySidebarRow & {
  details: string | null;
};
export type MemorySidebarInput = {
  summary: string;
  details: string | null;
};
type Props = {
  targetKey: string;
  employeeName: string;
  rows: readonly MemorySidebarRow[];
  loading?: boolean;
  error?: string;
  onReload: () => void;
  onReadDetail: (
    row: MemorySidebarRow,
    signal: AbortSignal,
  ) => Promise<MemorySidebarDetail>;
  onConfirm: (row: MemorySidebarRow) => Promise<void>;
  onDelete: (row: MemorySidebarRow) => Promise<void>;
  onSave: (
    input: MemorySidebarInput,
    row: MemorySidebarRow | null,
  ) => Promise<void>;
};

export function EmployeeMemorySidebar(props: Props) {
  return <Sidebar key={props.targetKey} {...props} />;
}

const fullMessage =
  '记忆已满（100 / 100）。删掉不再用的记忆后，才能新增或确认新的。';
const size = (value: string) => Array.from(value).length;
function dateParts(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (part: number) => String(part).padStart(2, '0');
  return {
    day: `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    today: date.toDateString() === new Date().toDateString(),
  };
}
function listDate(value: string) {
  const parts = dateParts(value);
  return parts ? (parts.today ? '今天' : parts.day) : '';
}

function Sidebar(props: Props) {
  const [selected, setSelected] = useState<MemorySidebarRow | null>(null);
  const [detail, setDetail] = useState<MemorySidebarDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const readController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const active = props.rows
    .filter((row) => row.state === 'active')
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const pending = props.rows
    .filter((row) => row.state === 'pending')
    .toSorted((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const full = active.length >= 100;
  const available = !props.loading && !props.error;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readController.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (selected && !props.rows.some((row) => row.id === selected.id)) {
      readController.current?.abort();
      setSelected(null);
      setDetail(null);
      setEditing(false);
    }
  }, [props.rows, selected]);

  function close() {
    if (busy) return;
    readController.current?.abort();
    setSelected(null);
    setDetail(null);
    setEditing(false);
    setReading(false);
    setError('');
  }
  async function read(row: MemorySidebarRow) {
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    setSelected(row);
    setDetail(null);
    setEditing(false);
    setError('');
    setReading(true);
    try {
      const value = await props.onReadDetail(row, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (value.id !== row.id) throw Error('Memory target changed');
      setDetail(value);
    } catch {
      if (alive.current && !controller.signal.aborted)
        setError('记忆读取失败，请重试。');
    } finally {
      if (alive.current && !controller.signal.aborted) setReading(false);
    }
  }
  function edit(value: MemorySidebarDetail | null) {
    readController.current?.abort();
    setSelected(value);
    setDetail(value);
    setSummary(value?.summary ?? '');
    setDetails(value?.details ?? '');
    setError('');
    setReading(false);
    setEditing(true);
  }
  async function mutate(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
      if (!alive.current) return;
      setSelected(null);
      setDetail(null);
      setEditing(false);
    } catch {
      if (alive.current) setError('暂时无法确认操作结果，请重新读取记忆。');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const canSave =
    available &&
    summary.trim().length > 0 &&
    size(summary) <= 40 &&
    size(details) <= 2000 &&
    (!full || selected?.state === 'active');
  const shown = detail ?? selected;
  const timestamp = shown
    ? dateParts(shown.state === 'active' ? shown.updatedAt : shown.capturedAt)
    : null;
  function renderRows(rows: MemorySidebarRow[]) {
    return (
      <ul className={css.list}>
        {rows.map((row) => (
          <li key={row.id} className={css.row} data-memory-id={row.id}>
            <button
              type="button"
              className={css.open}
              disabled={busy || !available}
              onClick={() => void read(row)}
            >
              <span
                className={`${css.dot} ${row.state === 'pending' ? css.pending : ''}`}
                aria-hidden="true"
              />
              <span className={css.summary}>{row.summary}</span>
              <time
                className={css.date}
                dateTime={
                  row.state === 'active' ? row.updatedAt : row.capturedAt
                }
              >
                {listDate(
                  row.state === 'active' ? row.updatedAt : row.capturedAt,
                )}
              </time>
            </button>
            {row.state === 'pending' && (
              <>
                <button
                  type="button"
                  className={css.confirm}
                  disabled={busy || full || !available}
                  onClick={() => void mutate(() => props.onConfirm(row))}
                >
                  确认
                </button>
                <button
                  type="button"
                  className={css.remove}
                  aria-label={`删除${row.summary}`}
                  disabled={busy || !available}
                  onClick={() => void mutate(() => props.onDelete(row))}
                >
                  ×
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <section className={css.panel} aria-label={`${props.employeeName} · 记忆`}>
      <header className={css.header}>
        <span className={css.avatar} aria-hidden="true">
          {Array.from(props.employeeName)[0]}
        </span>
        <div className={css.heading}>
          <h3>{props.employeeName} · 记忆</h3>
          <small>（确认后生效）</small>
        </div>
        <Button
          type="button"
          variant="outline"
          className={css.add}
          disabled={busy || full || !available}
          onClick={() => edit(null)}
        >
          ＋ 新增
        </Button>
      </header>
      <div className={css.body}>
        {props.loading ? (
          <p role="status" className={css.reading}>
            正在读取记忆…
          </p>
        ) : props.error ? (
          <p role="alert" className={css.message}>
            {props.error}{' '}
            <button type="button" onClick={props.onReload}>
              重试
            </button>
          </p>
        ) : (
          <>
            {full && <p className={css.warning}>{fullMessage}</p>}
            {pending.length > 0 && (
              <section aria-label="待确认">
                <h4 className={css.group}>待确认 {pending.length}</h4>
                {renderRows(pending)}
              </section>
            )}
            {props.rows.length ? (
              <section aria-label="生效中">
                <h4 className={css.group}>
                  <span>生效中</span>
                  <span>{active.length} / 100</span>
                </h4>
                {renderRows(active)}
              </section>
            ) : (
              <div className={css.empty}>
                <h4>还没有记忆</h4>
                <p>
                  聊天里提到的习惯和规则，{props.employeeName}{' '}
                  会记下来等你确认；也可以直接新增。
                </p>
              </div>
            )}
          </>
        )}
        {error && !selected && !editing && (
          <p role="alert" className={css.message}>
            {error}
          </p>
        )}
      </div>
      <Modal
        open={Boolean(selected || editing)}
        onClose={close}
        headless
        title={
          editing
            ? selected
              ? '修改记忆'
              : '新增记忆'
            : (shown?.summary ?? '记忆')
        }
        className={css.dialog}
      >
        <header className={css.dialogHeader}>
          {editing ? (
            <h2>{selected ? '修改记忆' : '新增记忆'}</h2>
          ) : (
            <span className={css.status}>
              <i
                className={`${css.dot} ${shown?.state === 'pending' ? css.pending : ''}`}
              />
              {shown?.state === 'active' ? '生效中' : '待确认'}
            </span>
          )}
          <button
            type="button"
            className={css.close}
            aria-label="关闭"
            disabled={busy}
            onClick={close}
          >
            ×
          </button>
        </header>
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (canSave)
                void mutate(() =>
                  props.onSave(
                    {
                      summary: summary.trim(),
                      details: details.trim() || null,
                    },
                    selected,
                  ),
                );
            }}
          >
            <div className={css.dialogBody}>
              <label className={css.field}>
                <span>
                  <span>一句话</span>
                  <span>{size(summary)} / 40 字</span>
                </span>
                <input
                  value={summary}
                  disabled={busy}
                  data-modal-autofocus
                  onChange={(event) => setSummary(event.target.value)}
                  required
                />
              </label>
              <label className={css.field}>
                <span>
                  <span>详细说明（选填）</span>
                  <span>{size(details)} / 2000 字</span>
                </span>
                <textarea
                  value={details}
                  disabled={busy}
                  onChange={(event) => setDetails(event.target.value)}
                  rows={6}
                />
              </label>
              <p className={css.hint}>
                保存后立即生效 · 生效中 {active.length} / 100
              </p>
              {error && (
                <p role="alert" className={css.message}>
                  {error}
                </p>
              )}
            </div>
            <footer className={css.footer}>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={close}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !canSave}
              >
                保存
              </Button>
            </footer>
          </form>
        ) : (
          <>
            <div className={css.dialogBody}>
              <h2 className={css.detailTitle}>{shown?.summary}</h2>
              {reading ? (
                <p role="status" className={css.reading}>
                  正在读取记忆…
                </p>
              ) : error ? (
                <p role="alert" className={css.message}>
                  {error}{' '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => selected && void read(selected)}
                  >
                    重试
                  </button>
                </p>
              ) : (
                detail &&
                (detail.details ? (
                  <p className={css.detailBody}>{detail.details}</p>
                ) : (
                  <p className={css.emptyDetails}>没有详细说明</p>
                ))
              )}
              {timestamp && (
                <p className={css.meta}>
                  {shown?.state === 'active'
                    ? `生效于 ${timestamp.day}`
                    : `添加于 ${timestamp.today ? '今天' : timestamp.day} ${timestamp.time}`}
                </p>
              )}
            </div>
            <footer className={css.footer}>
              <Button
                type="button"
                variant="ghost"
                className={css.deleteAction}
                disabled={busy || !shown || !available}
                onClick={() =>
                  shown && void mutate(() => props.onDelete(shown))
                }
              >
                删除
              </Button>
              <Button
                type="button"
                variant={shown?.state === 'active' ? 'primary' : 'outline'}
                disabled={busy || !detail || !available}
                onClick={() => detail && edit(detail)}
              >
                修改
              </Button>
              {shown?.state === 'pending' && (
                <Button
                  type="button"
                  variant="primary"
                  disabled={busy || full || !detail || !available}
                  onClick={() =>
                    detail && void mutate(() => props.onConfirm(detail))
                  }
                >
                  确认
                </Button>
              )}
            </footer>
          </>
        )}
      </Modal>
    </section>
  );
}
