'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button, Menu, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import type { NativeSubagentSummary } from '@allrice/contracts';
import {
  nativeSubagentElapsedMs,
  nativeSubagentEntryState,
  nativeSubagentReference,
  nativeSubagentScopeKey,
  type NativeSubagentReference,
  type NativeSubagentViewScope,
} from '../../lib/chatflow/native-subagent-view';
import { AssistantMarkdown } from './assistant-markdown';
import type { useNativeSubagents } from './use-native-subagents';
import { useNativeSubagentFollow } from './use-native-subagent-follow';
import { NativeSubagentProcess } from './native-subagent-process';
import {
  NativeSubagentControls,
  useNativeSubagentControls,
  type nativeSubagentControlRoot,
} from './native-subagent-controls';
import type { ChatPresentationPolicy } from './dsh-upstream/presentation/presentation-policy';
import { WorkbenchIcon } from './workbench-modules';
import actions from './workbench-modules.module.css';
import css from './native-subagent-directory.module.css';

type Entry = NativeSubagentSummary['descendants'][number];
type Child = Extract<Entry, { kind: 'child' }>;
const activity = (child: Child) =>
  child.running === true
    ? '运行中'
    : child.running === null
      ? '当前活动状态未知'
      : child.timing.lastTurnCompleted
        ? '上次回合已完成'
        : '未运行';
function elapsed(child: Child, now = child.timing.active?.through) {
  const { active, settledMs } = child.timing;
  const seconds = Math.floor(
    (settledMs +
      (active ? Math.max(0, (now ?? active.through) - active.since) : 0)) /
      1000,
  );
  return `${seconds} 秒`;
}
function metrics(child: Child) {
  return `${Object.values(child.usage)
    .reduce((a, b) => a + b, 0)
    .toLocaleString()} tokens · ${elapsed(child)}`;
}

export function EmptyNativeSubagentDirectory() {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      portal
      align="end"
      autoFocus={false}
      open={open}
      onClose={() => setOpen(false)}
      listClassName={css.catalog}
      anchor={
        <Button
          size="sm"
          className={`${actions.iconButton} ${css.trigger}`}
          aria-expanded={open}
          aria-haspopup="tree"
          aria-label="子智能体"
          onClick={() => setOpen(!open)}
          onKeyDown={(event) => {
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          <WorkbenchIcon kind="subagent" />
        </Button>
      }
    >
      <h2 className={css.title}>子智能体</h2>
      <p className={`${css.message} ${css.empty}`}>暂无子智能体</p>
    </Menu>
  );
}

type NativeSubagentDirectoryProps = {
  workspaceId: string;
  sessionId: string;
  headers: Record<string, string>;
  observation: ReturnType<typeof useNativeSubagents>;
  presentation: ChatPresentationPolicy;
  controlRoot?: ReturnType<typeof nativeSubagentControlRoot>;
  canControl?: boolean;
  viewerId?: string | null;
  scope?: NativeSubagentViewScope;
  onOpen?: (reference: NativeSubagentReference) => void;
  openRequest?: { id: number; scopeKey: string };
  employeeName?: string;
};
export function NativeSubagentDirectory({
  workspaceId,
  sessionId,
  observation,
  scope,
  onOpen,
  openRequest,
  employeeName,
}: NativeSubagentDirectoryProps) {
  const scopeKey = scope
    ? nativeSubagentScopeKey(scope)
    : JSON.stringify([workspaceId, sessionId]);
  const [openedScope, setOpenedScope] = useState<string | null>(null);
  const open = openedScope === scopeKey;
  const openRef = useRef(false);
  const { reads, refresh } = observation;
  const showCatalog = (nextOpen: boolean) => {
    if (nextOpen && !openRef.current) refresh();
    openRef.current = nextOpen;
    setOpenedScope(nextOpen ? scopeKey : null);
  };
  const read = reads[sessionId];
  const summary = read && read !== 'error' ? read : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const catalog = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const close = () => showCatalog(false);
  useEffect(() => {
    setOpenedScope(null);
    openRef.current = false;
    setExpanded(new Set());
  }, [scopeKey]);
  const requestId =
    openRequest?.scopeKey === scopeKey ? openRequest.id : undefined;
  useEffect(() => {
    if (requestId !== undefined) {
      pendingFocus.current = true;
      showCatalog(true);
    }
  }, [requestId, scopeKey]);
  useEffect(() => {
    if (!open) pendingFocus.current = false;
    else if (summary && pendingFocus.current) {
      const first = catalog.current?.querySelector<HTMLElement>('[data-child]');
      if (first) {
        pendingFocus.current = false;
        first.focus();
      }
    }
  }, [open, summary]);
  const direct =
    summary?.descendants.filter((child) => child.parentId === summary.rootId) ??
    [];
  const [now, setNow] = useState(Date.now);
  const ticking =
    open &&
    summary?.root.source === 'live' &&
    summary.descendants.some(
      (entry) =>
        entry.kind === 'child' &&
        entry.observation.source === 'live' &&
        entry.running === true &&
        entry.timing.active,
    );
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const toggle = (id: string) =>
    setExpanded((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const openEntry = (entry: Entry) => {
    if (
      !scope ||
      scope.workspaceId !== workspaceId ||
      scope.sessionId !== sessionId ||
      !summary ||
      !onOpen
    )
      return;
    onOpen(nativeSubagentReference(scope, summary, entry));
    close();
  };
  const rows = (parentId: string): ReactNode =>
    summary?.descendants
      .filter((entry) => entry.parentId === parentId)
      .map((entry) => {
        const branch = summary.descendants.some(
          (other) => other.parentId === entry.id,
        );
        const label =
          entry.kind === 'child' ? (entry.label ?? entry.id) : entry.id;
        const status = nativeSubagentEntryState(summary, entry);
        const duration =
          entry.kind === 'child'
            ? nativeSubagentElapsedMs(summary, entry, now)
            : undefined;
        const usage = entry.kind === 'child' ? Object.values(entry.usage) : [];
        const tokens =
          usage.length === 4 &&
          usage.every((value) => Number.isFinite(value) && value >= 0)
            ? `${usage.reduce((a, b) => a + b, 0).toLocaleString()} tokens`
            : '—';
        return (
          <li
            role="treeitem"
            key={entry.id}
            aria-expanded={branch ? expanded.has(entry.id) : undefined}
            tabIndex={0}
            data-child={entry.id}
            data-parent={parentId}
            aria-label={`${label}摘要`}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                ['Enter', ' '].includes(event.key)
              ) {
                event.preventDefault();
                openEntry(entry);
              }
            }}
          >
            <div className={css.row}>
              {branch ? (
                <Button
                  size="sm"
                  className={css.branch}
                  aria-label={`${expanded.has(entry.id) ? '收起' : '展开'}${label}`}
                  aria-expanded={expanded.has(entry.id)}
                  onClick={() => toggle(entry.id)}
                >
                  {expanded.has(entry.id) ? '▾' : '▸'}
                </Button>
              ) : (
                <span className={css.branchSpacer} aria-hidden />
              )}
              <button
                type="button"
                className={css.entry}
                data-state={status.state}
                onClick={() => openEntry(entry)}
                aria-label={`${label}，${status.text}，${entry.kind === 'diagnostic' ? '查看读取说明' : '在工作台打开'}`}
              >
                <span className={css.stateDot} aria-hidden />
                <span className={css.copy}>
                  <span className={css.label}>{label}</span>
                  {entry.kind === 'child' && entry.task && (
                    <span className={css.task}>{entry.task}</span>
                  )}
                  <span className={css.status}>{status.text}</span>
                </span>
                <Tooltip
                  label="累计用量可能包含继承历史；用时来自已读取记录"
                  side="top"
                  portal
                >
                  <span className={css.metadata}>
                    {tokens}
                    <span className={css.duration}>
                      {duration === undefined
                        ? '—'
                        : `${Math.floor(duration / 1000)}秒`}
                    </span>
                  </span>
                </Tooltip>
                <span className={css.entryArrow} aria-hidden>
                  ›
                </span>
              </button>
            </div>
            {branch && expanded.has(entry.id) && (
              <ul role="group">{rows(entry.id)}</ul>
            )}
          </li>
        );
      });
  const running = direct.filter(
    (entry) =>
      entry.kind === 'child' &&
      summary?.root.source === 'live' &&
      entry.observation.source === 'live' &&
      entry.running === true,
  ).length;
  return (
    <div
      onBlurCapture={() => {
        pendingFocus.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          close();
          trigger.current?.focus();
          return;
        }
        const buttons = [
          ...(catalog.current?.querySelectorAll<HTMLElement>('[data-child]') ??
            []),
        ];
        const current = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-child]',
        );
        const at = current ? buttons.indexOf(current) : -1;
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
          showCatalog(true);
          requestAnimationFrame(() =>
            catalog.current
              ?.querySelectorAll<HTMLElement>('[data-child]')
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
            className={`${actions.iconButton} ${css.trigger}`}
            aria-expanded={open}
            aria-haspopup="tree"
            aria-label={
              read === 'error'
                ? '子智能体读取失败'
                : summary
                  ? `${direct.length} 个子智能体${running ? ` · ${running} 个运行中` : ''}`
                  : '子智能体'
            }
            onClick={() => showCatalog(!open)}
          >
            <WorkbenchIcon kind="subagent" />
            {(read === 'error' || running > 0) && (
              <span
                className={`${actions.badge} ${read === 'error' ? css.errorBadge : css.runningBadge}`}
                aria-hidden
              >
                {read === 'error' ? '!' : running}
              </span>
            )}
          </Button>
        }
      >
        <div ref={catalog}>
          <div className={css.catalogHead}>
            <h2 className={css.title}>
              {employeeName ? `${employeeName} · 子智能体` : '子智能体'}
            </h2>
            {summary && (
              <span className={css.message}>
                {direct.length} 个{running ? ` · ${running} 个运行中` : ''}
              </span>
            )}
          </div>
          {read === undefined ? (
            <div className={css.loading}>
              <p className={css.message} role="status">
                正在读取子智能体摘要…
              </p>
              <div className={css.skeleton} aria-hidden>
                <span />
                <span />
              </div>
            </div>
          ) : read === null ? (
            <p className={css.message} role="status">
              当前活动状态未知，请重新读取摘要。
            </p>
          ) : read === 'error' ? (
            <p className={css.message} role="alert">
              {observation.disconnected?.[sessionId]
                ? '实时观察已断开，重试。'
                : '暂时读不到子智能体目录。'}
            </p>
          ) : summary && !direct.length ? (
            <p className={`${css.message} ${css.empty}`}>暂无子智能体</p>
          ) : (
            <ul role="tree" aria-label="子智能体目录">
              {summary && rows(summary.rootId)}
            </ul>
          )}
        </div>
      </Menu>
    </div>
  );
}

/** Retained for direct component regression; the product directory has no detail entry. */
export function NativeSubagentDetail({
  workspaceId,
  sessionId,
  headers,
  observation,
  presentation,
  controlRoot,
  canControl = false,
  viewerId,
  selected,
  onClose: dismissDetail,
}: NativeSubagentDirectoryProps & {
  selected: string | null;
  onClose: () => void;
}) {
  const controls = useNativeSubagentControls(
    workspaceId,
    sessionId,
    headers,
    viewerId,
  );
  const { reads, revision } = observation;
  const read = reads[sessionId];
  const summary = read && read !== 'error' ? read : null;
  const follow = useNativeSubagentFollow(
    workspaceId,
    sessionId,
    headers,
    summary,
    selected,
    String(revision),
  );
  const hot =
    follow.view && typeof follow.view === 'object' ? follow.view : null;
  const snapshot = hot && 'rows' in hot ? hot : null;
  const detailSummary = hot && 'descendants' in hot ? hot : summary;
  const child = detailSummary?.descendants.find(
    (entry) => entry.id === selected && entry.kind === 'child',
  ) as Child | undefined;
  return (
    <>
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
            {child && follow.view !== 'error' && (!follow.enabled || hot) ? (
              <>
                <p>
                  {child.observation.source === 'prepared'
                    ? `历史摘要 · ${activity(child)}`
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
                <h3>{snapshot ? '自己的过程' : '最后回复'}</h3>
                {snapshot ? (
                  <NativeSubagentProcess
                    key={`${snapshot.childId}/${snapshot.hostEpoch}/${snapshot.stream.instanceId}`}
                    snapshot={snapshot}
                    policy={presentation}
                  />
                ) : (
                  <AssistantMarkdown
                    text={child.lastReply ?? '暂无回复'}
                    allowRemoteImages={false}
                  />
                )}
                {!snapshot && child.lastReplyTruncated && (
                  <small>最后回复已截断。</small>
                )}
              </>
            ) : (
              <p role="status">
                {read === 'error' || follow.view === 'error'
                  ? '暂时无法读取摘要，请刷新。'
                  : '当前活动状态未知，请重新读取摘要。'}
              </p>
            )}
            {controlRoot !== undefined && (
              <NativeSubagentControls
                key={`${selected}/${child?.parentId}/${controlRoot?.rootRunId}/${controlRoot?.generation}`}
                childId={selected}
                child={child}
                parentAvailable={
                  summary?.descendants.find(
                    (entry): entry is Child =>
                      entry.kind === 'child' &&
                      entry.id === selected &&
                      entry.parentId === child?.parentId,
                  )?.parentAvailable
                }
                root={controlRoot}
                permitted={canControl}
                controls={controls}
              />
            )}
          </aside>,
          document.body,
        )}
    </>
  );
}
