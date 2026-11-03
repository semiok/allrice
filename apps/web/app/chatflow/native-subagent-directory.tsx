'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  Menu,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { NativeSubagentSummary } from '@allrice/contracts';
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
const catalogActivity = (child: Child) =>
  child.running === true
    ? '运行中'
    : child.running === null
      ? '状态未知'
      : child.timing.lastTurnCompleted === undefined
        ? '未运行'
        : '已结束';
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
  const [open, setOpen] = useState<'preview' | 'pinned' | false>(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Menu
      portal
      align="end"
      autoFocus={false}
      open={!!open}
      closeOnPointerLeave={open === 'preview'}
      onClose={() => {
        clearTimeout(timer.current);
        setOpen(false);
      }}
      listClassName={css.catalog}
      anchor={
        <Button
          size="sm"
          className={`${actions.iconButton} ${css.trigger}`}
          aria-expanded={!!open}
          aria-haspopup="tree"
          aria-label="子智能体"
          onMouseEnter={() => {
            if (!open)
              timer.current = setTimeout(() => setOpen('preview'), 150);
          }}
          onMouseLeave={() => clearTimeout(timer.current)}
          onClick={() => {
            clearTimeout(timer.current);
            setOpen((value) => (value === 'pinned' ? false : 'pinned'));
          }}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
              return;
            event.preventDefault();
            setOpen((value) => value || 'preview');
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
};
export function NativeSubagentDirectory({
  sessionId,
  observation,
}: NativeSubagentDirectoryProps) {
  const [open, setOpen] = useState(false),
    [pinned, setPinned] = useState(false);
  const openRef = useRef(false);
  const { reads, refresh } = observation;
  const showCatalog = (nextOpen: boolean) => {
    if (nextOpen && !openRef.current) refresh();
    openRef.current = nextOpen;
    setOpen(nextOpen);
  };
  const read = reads[sessionId];
  const summary = read && read !== 'error' ? read : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const catalog = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = () => {
    clearTimeout(timer.current);
    showCatalog(false);
    setPinned(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) pendingFocus.current = false;
    else if (summary && pendingFocus.current) {
      const first = catalog.current?.querySelector<HTMLElement>(
        '[data-child]:not([aria-disabled="true"])',
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
  const [now, setNow] = useState(Date.now);
  const ticking =
    open &&
    summary?.descendants.some(
      (entry) =>
        entry.kind === 'child' && entry.running === true && entry.timing.active,
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
  const rows = (parentId: string) =>
    summary?.descendants
      .filter((entry) => entry.parentId === parentId)
      .map((entry) => {
        const branch = summary.descendants.some(
          (other) => other.parentId === entry.id,
        );
        const label =
          entry.kind === 'child' ? (entry.label ?? entry.id) : entry.id;
        const status =
          entry.kind === 'diagnostic'
            ? diagnostic[entry.reason]
            : catalogActivity(entry);
        const abnormal =
          entry.kind === 'child' &&
          entry.running === false &&
          entry.timing.lastTurnCompleted === false;
        return (
          <li
            role="treeitem"
            key={entry.id}
            aria-expanded={branch ? expanded.has(entry.id) : undefined}
            tabIndex={entry.kind === 'child' ? 0 : undefined}
            data-child={entry.id}
            data-parent={parentId}
            aria-label={`${label}摘要`}
            aria-description={abnormal ? '未正常结束' : undefined}
            aria-disabled={entry.kind === 'diagnostic' || undefined}
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
              <div className={css.entry}>
                <span className={css.label}>{label}</span>
                <small className={css.metadata}>
                  <span className={css.status}>
                    {entry.kind === 'child' && entry.running !== null ? (
                      <StateDot
                        size={8}
                        state={
                          entry.running
                            ? 'ongoing'
                            : entry.timing.lastTurnCompleted
                              ? 'done'
                              : 'idle'
                        }
                      />
                    ) : (
                      <span
                        className={css.unobserved}
                        aria-label="活动状态未观测"
                      />
                    )}
                    <span>{status}</span>
                    {abnormal && (
                      <Tooltip label="未正常结束" side="top" portal>
                        <span
                          className={css.abnormal}
                          role="img"
                          aria-label="未正常结束"
                        >
                          !
                        </span>
                      </Tooltip>
                    )}
                  </span>
                  {entry.kind === 'child' && (
                    <span className={css.duration}>
                      {elapsed(entry, entry.running === true ? now : undefined)}
                    </span>
                  )}
                </small>
              </div>
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
  return (
    <>
      <div
        onBlurCapture={() => {
          pendingFocus.current = false;
        }}
        onMouseEnter={() => {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => showCatalog(true), 150);
        }}
        onMouseLeave={() => {
          clearTimeout(timer.current);
          if (!pinned)
            timer.current = setTimeout(() => showCatalog(false), 120);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            close();
            trigger.current?.focus();
            return;
          }
          const buttons = [
            ...(catalog.current?.querySelectorAll<HTMLElement>(
              '[data-child]:not([aria-disabled="true"])',
            ) ?? []),
          ];
          const at = buttons.indexOf(event.target as HTMLElement);
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
                ?.querySelectorAll<HTMLElement>(
                  '[data-child]:not([aria-disabled="true"])',
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
              onClick={() => {
                clearTimeout(timer.current);
                setPinned(!pinned);
                showCatalog(!pinned);
              }}
            >
              <WorkbenchIcon kind="subagent" />
              {(read === 'error' || running > 0) && (
                <span
                  className={`${actions.badge} ${read === 'error' ? css.errorBadge : css.runningBadge}`}
                  aria-hidden="true"
                >
                  {read === 'error' ? '!' : running}
                </span>
              )}
            </Button>
          }
        >
          <div ref={catalog}>
            <h2 className={css.title}>子智能体</h2>
            {read === undefined ? (
              <div className={css.loading}>
                <p className={css.message} role="status">
                  正在读取子智能体摘要…
                </p>
                <div className={css.skeleton} aria-hidden="true">
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
    </>
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
