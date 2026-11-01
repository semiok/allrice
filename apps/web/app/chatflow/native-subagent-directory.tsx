'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Menu, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
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

export function NativeSubagentDirectory({
  workspaceId,
  sessionId,
  headers,
  observation,
  presentation,
  controlRoot,
  canControl = false,
  viewerId,
}: {
  workspaceId: string;
  sessionId: string;
  headers: Record<string, string>;
  observation: ReturnType<typeof useNativeSubagents>;
  presentation: ChatPresentationPolicy;
  controlRoot?: ReturnType<typeof nativeSubagentControlRoot>;
  canControl?: boolean;
  viewerId?: string | null;
}) {
  const controls = useNativeSubagentControls(
    workspaceId,
    sessionId,
    headers,
    viewerId,
  );
  const [open, setOpen] = useState(false),
    [pinned, setPinned] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const { reads, refresh, revision } = observation;
  const showCatalog = (nextOpen: boolean, nextSelected = selected) => {
    setOpen(nextOpen);
    setSelected(nextSelected);
  };
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
  const catalog = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = (nextSelected = selected) => {
    clearTimeout(timer.current);
    showCatalog(false, nextSelected);
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
  const [now, setNow] = useState(Date.now);
  const ticking =
    open &&
    direct.some(
      (entry) =>
        entry.kind === 'child' && entry.running === true && entry.timing.active,
    );
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  const child = detailSummary?.descendants.find(
    (entry) => entry.id === selected && entry.kind === 'child',
  ) as Child | undefined;
  const rows = () =>
    summary?.descendants
      .filter((entry) => entry.parentId === summary.rootId)
      .map((entry) => {
        const label =
          entry.kind === 'child' ? (entry.label ?? entry.id) : entry.id;
        const status =
          entry.kind === 'diagnostic'
            ? diagnostic[entry.reason]
            : entry.running === null && entry.timing.lastTurnCompleted
              ? '历史记录 · 上次回合已完成'
              : activity(entry);
        return (
          <li role="treeitem" key={entry.id}>
            <div className={css.row}>
              <Button
                className={css.entry}
                size="sm"
                data-child={entry.id}
                data-parent={summary.rootId}
                aria-label={`查看${label}摘要`}
                disabled={entry.kind === 'diagnostic'}
                onClick={() => {
                  close(entry.id);
                }}
              >
                {entry.kind === 'child' && entry.running !== null ? (
                  <StateDot
                    size={10}
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
                <span className={css.label}>
                  <strong>{label}</strong>
                </span>
                <small>
                  {status}
                  {entry.kind === 'child' &&
                    ` · ${elapsed(entry, entry.running === true ? now : undefined)}`}
                </small>
              </Button>
            </div>
          </li>
        );
      });
  const running = direct.filter(
    (entry) => entry.kind === 'child' && entry.running === true,
  ).length;
  const dismissDetail = () => {
    clearTimeout(timer.current);
    showCatalog(open, null);
    trigger.current?.focus();
  };
  if (!selected && !open && read !== 'error' && !direct.length) return null;
  return (
    <>
      <div
        hidden={read !== 'error' && !direct.length}
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
            showCatalog(true);
            requestAnimationFrame(() =>
              catalog.current
                ?.querySelectorAll<HTMLButtonElement>(
                  'button[data-child]:not(:disabled)',
                )
                .item(target)
                ?.focus(),
            );
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
                  : `${direct.length} 个子智能体${running ? ` · ${running} 个运行中` : ''}`
              }
              onClick={() => {
                clearTimeout(timer.current);
                setPinned(!pinned);
                showCatalog(!pinned);
              }}
            >
              <WorkbenchIcon kind="subagent" />
              {read !== 'error' && running > 0 && (
                <StateDot state="ongoing" size={10} className={css.ongoing} />
              )}
              <span
                className={`${actions.badge} ${read === 'error' ? css.errorBadge : actions.neutralBadge}`}
                aria-hidden="true"
              >
                {read === 'error' ? '!' : direct.length}
              </span>
            </Button>
          }
        >
          <div ref={catalog}>
            {summary && (
              <p>
                {direct.length} 个子智能体
                {running > 0 && ` · ${running} 个运行中`}
              </p>
            )}
            {read === undefined ? (
              <p role="status">正在读取子智能体摘要…</p>
            ) : read === 'error' ? (
              <p role="alert">
                {observation.disconnected?.[sessionId]
                  ? '实时观察已断开，重试。'
                  : '暂时读不到子智能体目录。'}
              </p>
            ) : summary && !direct.length ? (
              <p>暂无子智能体</p>
            ) : (
              <ul role="tree" aria-label="子智能体目录">
                {summary && rows()}
              </ul>
            )}
            {[
              ...new Set(
                controls.attempts.map((a) => a.reference.input.childSessionId),
              ),
            ]
              .filter(
                (id) =>
                  !summary?.descendants.some(
                    (entry) => entry.kind === 'child' && entry.id === id,
                  ),
              )
              .map((id) => (
                <Button key={id} size="sm" onClick={() => close(id)}>
                  查看{id}原请求回执
                </Button>
              ))}
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
            <Button size="sm" onClick={refresh}>
              刷新子智能体摘要
            </Button>
          </aside>,
          document.body,
        )}
    </>
  );
}
