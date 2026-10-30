'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Menu, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NativeSubagentSummary } from '@allrice/contracts';
import { AssistantMarkdown } from './assistant-markdown';
import { useNativeSubagents } from './use-native-subagents';
import css from './native-subagent-directory.module.css';

type Entry = NativeSubagentSummary['descendants'][number];
type Child = Extract<Entry, { kind: 'child' }>;
const diagnostic = {
  corrupt: '记录损坏',
  unavailable: '暂时无法读取',
  unsupported: '暂不支持此类型',
  identity_mismatch: '身份校验未通过',
  parent_unverified: '父子关系未确认',
};
const activity = (child: Child) =>
  child.running === true
    ? '运行中'
    : child.running === null
      ? '当前活动状态未知'
      : child.timing.lastTurnCompleted
        ? '上次回合已完成'
        : '未运行';
function metrics(child: Child) {
  const { active, settledMs } = child.timing;
  const seconds = Math.floor(
    (settledMs + (active ? Math.max(0, active.through - active.since) : 0)) /
      1000,
  );
  return `${Object.values(child.usage)
    .reduce((a, b) => a + b, 0)
    .toLocaleString()} tokens · ${seconds} 秒`;
}

export function NativeSubagentDirectory({
  workspaceId,
  sessionId,
  headers,
  refreshKey,
}: {
  workspaceId: string;
  sessionId: string;
  headers: Record<string, string>;
  refreshKey: string;
}) {
  const [open, setOpen] = useState(false),
    [pinned, setPinned] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { reads, refresh } = useNativeSubagents(
    workspaceId,
    headers,
    { [sessionId]: refreshKey },
    !open && !selected,
  );
  const read = reads[sessionId];
  const summary = read && read !== 'error' ? read : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const catalog = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = () => {
    clearTimeout(timer.current);
    setOpen(false);
    setPinned(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) pendingFocus.current = false;
    else if (summary && pendingFocus.current) {
      const first = catalog.current?.querySelector<HTMLButtonElement>(
        'button[data-child]:not(:disabled)',
      );
      if (first) {
        pendingFocus.current = false;
        first.focus();
      }
    }
  }, [open, summary]);
  const direct =
    summary?.descendants.filter((child) => child.parentId === summary.rootId) ??
    [];
  const child = summary?.descendants.find(
    (entry) => entry.id === selected && entry.kind === 'child',
  ) as Child | undefined;
  const toggle = (id: string) =>
    setExpanded((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rows = (parentId: string) =>
    summary?.descendants
      .filter((entry) => entry.parentId === parentId)
      .map((entry) => {
        const branch = summary.descendants.some(
          (other) => other.parentId === entry.id,
        );
        const label =
          entry.kind === 'child' ? (entry.label ?? entry.id) : entry.id;
        return (
          <li
            role="treeitem"
            key={entry.id}
            aria-expanded={branch ? expanded.has(entry.id) : undefined}
          >
            <div className={css.row}>
              {branch && (
                <Button
                  size="sm"
                  aria-label={`${expanded.has(entry.id) ? '收起' : '展开'}${label}`}
                  onClick={() => toggle(entry.id)}
                >
                  {expanded.has(entry.id) ? '▾' : '▸'}
                </Button>
              )}
              <Button
                className={css.entry}
                size="sm"
                data-child={entry.id}
                data-parent={parentId}
                aria-label={`查看${label}摘要`}
                disabled={entry.kind === 'diagnostic'}
                onClick={() => {
                  setSelected(entry.id);
                  close();
                }}
              >
                {entry.kind === 'child' && entry.running !== null ? (
                  <StateDot
                    state={
                      entry.running
                        ? 'ongoing'
                        : entry.timing.lastTurnCompleted
                          ? 'done'
                          : 'idle'
                    }
                  />
                ) : (
                  <span aria-label="活动状态未知">?</span>
                )}
                <span className={css.label}>
                  <strong>{label}</strong>
                  <small>
                    {entry.kind === 'child'
                      ? [
                          entry.title,
                          entry.mode === 'one-shot' ? '一次性' : '可继续',
                          activity(entry),
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : diagnostic[entry.reason]}
                  </small>
                </span>
                {entry.kind === 'child' && <small>{metrics(entry)} →</small>}
              </Button>
            </div>
            {branch && expanded.has(entry.id) && (
              <ul role="group">{rows(entry.id)}</ul>
            )}
          </li>
        );
      });
  const running = direct.filter(
    (entry) => entry.kind === 'child' && entry.running === true,
  ).length;
  const unknown = direct.some(
    (entry) => entry.kind === 'diagnostic' || entry.running === null,
  );
  const runningLabel = unknown
    ? running
      ? `至少 ${running} 个运行中 · 部分状态未知`
      : '运行状态未知'
    : `${running} 个运行中`;
  const dismissDetail = () => {
    setSelected(null);
    trigger.current?.focus();
  };
  if (!selected && !open && summary && !direct.length) return null;
  return (
    <>
      <div
        onMouseEnter={() => {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setOpen(true), 150);
        }}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          if (!pinned) timer.current = setTimeout(() => setOpen(false), 120);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            close();
            trigger.current?.focus();
            return;
          }
          const buttons = [
            ...(catalog.current?.querySelectorAll<HTMLButtonElement>(
              'button[data-child]:not(:disabled)',
            ) ?? []),
          ];
          const at = buttons.indexOf(event.target as HTMLButtonElement);
          const target =
            at < 0
              ? 0
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : at + (event.key === 'ArrowUp' ? -1 : 1);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            pendingFocus.current = at < 0 && !buttons.length;
            setOpen(true);
            requestAnimationFrame(() =>
              catalog.current
                ?.querySelectorAll<HTMLButtonElement>(
                  'button[data-child]:not(:disabled)',
                )
                .item(target)
                ?.focus(),
            );
          }
          if (at >= 0 && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
            event.preventDefault();
            const id = buttons[at]!.dataset.child!;
            if (event.key === 'ArrowRight' && expanded.has(id))
              buttons[at + 1]?.focus();
            else if (
              summary?.descendants.some((entry) => entry.parentId === id) &&
              (event.key === 'ArrowRight') !== expanded.has(id)
            )
              toggle(id);
            else if (event.key === 'ArrowLeft')
              buttons
                .find(
                  (button) =>
                    button.dataset.child === buttons[at]!.dataset.parent,
                )
                ?.focus();
          }
        }}
      >
        <Menu
          portal
          align="end"
          autoFocus={false}
          open={open}
          onClose={close}
          listClassName={css.catalog}
          anchor={
            <Button
              ref={trigger}
              size="sm"
              aria-expanded={open}
              aria-haspopup="tree"
              onClick={() => {
                clearTimeout(timer.current);
                setPinned(!pinned);
                setOpen(!pinned);
              }}
            >
              {read === 'error'
                ? '子智能体读取失败'
                : summary
                  ? `${direct.length} 个子智能体 · ${runningLabel}`
                  : '子智能体状态未知'}
            </Button>
          }
        >
          <div ref={catalog}>
            {read === undefined ? (
              <p role="status">正在读取子智能体摘要…</p>
            ) : read === 'error' ? (
              <p role="alert">暂时读不到子智能体目录。</p>
            ) : summary && !direct.length ? (
              <p>暂无子智能体</p>
            ) : (
              <ul role="tree" aria-label="子智能体目录">
                {summary && rows(summary.rootId)}
              </ul>
            )}
            <Button size="sm" onClick={refresh}>
              刷新子智能体摘要
            </Button>
          </div>
        </Menu>
      </div>
      {selected &&
        createPortal(
          <aside
            className={css.detail}
            aria-label="子智能体摘要"
            onKeyDown={(event) => {
              if (event.key === 'Escape') dismissDetail();
            }}
          >
            <header>
              <strong>{child?.label ?? selected}</strong>
              <Button size="sm" autoFocus onClick={dismissDetail}>
                关闭摘要
              </Button>
            </header>
            {child ? (
              <>
                <p>
                  {child.observation.source === 'prepared'
                    ? '历史摘要 · 当前活动状态未知'
                    : `运行摘要 · ${activity(child)}`}
                </p>
                {child.title && <h2>{child.title}</h2>}
                <h3>自己的任务</h3>
                <p className={css.text}>{child.task ?? '暂无自有任务记录'}</p>
                {child.running !== true && child.timing.lastTurnCompleted && (
                  <p>上次回合已完成。</p>
                )}
                <p>读取时累计：{metrics(child)}</p>
                <small>
                  用量可能包含继承历史，不代表本次运行账单。耗时冻结于读取时。
                </small>
                <h3>最后回复</h3>
                <AssistantMarkdown
                  text={child.lastReply ?? '暂无回复'}
                  allowRemoteImages={false}
                />
              </>
            ) : (
              <p role="status">
                {read === 'error'
                  ? '暂时无法读取摘要，请刷新。'
                  : '当前活动状态未知，请重新读取摘要。'}
              </p>
            )}
            <Button size="sm" onClick={refresh}>
              刷新子智能体摘要
            </Button>
          </aside>,
          document.body,
        )}
    </>
  );
}
