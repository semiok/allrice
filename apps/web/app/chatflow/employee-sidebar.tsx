'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useNativeSubagents,
  nativeSubagentActivityUnknown,
} from './use-native-subagents';
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconClockOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import type { useSessionArchive } from './use-session-archive';
import type { Session, Workspace } from './chatflow-types';
import { ProjectRowItem, SessionNodeItem } from './dsh-upstream/workspace/Rows';
import {
  employeeAccent,
  employeeAccentStyle,
  employeeGroups,
  employeePreferenceKey,
  employeeSessionPreview,
  employeeSessionPreviewLimit,
  employeeTranslate,
  readEmployeeExpansion,
} from './employee-navigation';
import css from './employee-sidebar.module.css';
import {
  employeeChoice,
  employeeChoiceProfile,
  sessionEmployeeKey,
} from './employee-instances';

export function EmployeeSidebar({
  workspace,
  sessions,
  activeId,
  collapsed,
  onSelectSession,
  onPrepareSession,
  onDetails,
  archive,
  scheduledSessions,
}: {
  archive?: ReturnType<typeof useSessionArchive>;
  scheduledSessions?: ReadonlySet<string>;
  workspace: Workspace;
  sessions: Session[];
  activeId: string | null;
  collapsed: boolean;
  onSelectSession: (id: string) => void;
  onPrepareSession: (id: string) => void;
  onDetails: (assignmentId: string) => void;
}) {
  const key = employeePreferenceKey(workspace);
  const root = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<string[]>([]);
  const { reads } = useNativeSubagents(
    workspace.workspaceId,
    {
      'x-allrice-organization-id': workspace.organizationId,
      'x-allrice-workspace-id': workspace.workspaceId,
    },
    Object.fromEntries(
      sessions
        .filter(
          (session) =>
            visible.includes(session.id) &&
            (!session.ownerId || session.ownerId === workspace.viewerId),
        )
        .map((session) => [
          session.id,
          `${session.updatedAt}/${session.running}`,
        ]),
    ),
    true,
  );
  const [expansion, setExpansion] = useState(() => readEmployeeExpansion(key));
  const [all, setAll] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState<string | null>(null);
  const activeSession = sessions.find((session) => session.id === activeId);
  const activeGroup = activeSession
    ? sessionEmployeeKey(activeSession)
    : undefined;
  useEffect(() => {
    if (activeGroup)
      setExpansion((current) => ({ ...current, [activeGroup]: true }));
  }, [activeId, activeGroup]);
  useEffect(() => {
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(expansion));
    } catch {
      /* Optional preference storage. */
    }
  }, [key, expansion]);
  const groups = useMemo(
    () =>
      employeeGroups(
        workspace,
        sessions,
        activeId,
        expansion,
        archive?.filter,
        archive?.employeeGroups,
        reads,
      ),
    [
      workspace,
      sessions,
      activeId,
      expansion,
      archive?.filter,
      archive?.employeeGroups,
      reads,
    ],
  );
  useEffect(() => {
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.rowKey!.slice(
            'session:'.length,
          );
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const ids = [...visible].sort();
        setVisible((before) => (before.join() === ids.join() ? before : ids));
      },
      { root: root.current },
    );
    const rows = root.current?.querySelectorAll('[data-row-key^="session:"]');
    rows?.forEach((row) => observer.observe(row));
    if (!rows?.length) setVisible([]);
    return () => observer.disconnect();
  }, [groups, collapsed, all]);
  useEffect(() => {
    if (collapsed || !archive || archive.loading) return;
    for (const group of groups) {
      if (
        group.expanded &&
        group.sessions.length <
          Math.min(employeeSessionPreviewLimit, group.sessionCount) &&
        !archive.employeePages?.[group.key]
      )
        archive.loadPreview(group.key);
    }
  }, [archive, collapsed, groups]);
  if (!groups.length) return <p className={css.empty}>当前没有可用员工</p>;
  const prepareSession = (target: EventTarget) => {
    if (!(target instanceof Element)) return;
    const key = target.closest('[data-row-key]')?.getAttribute('data-row-key');
    if (key?.startsWith('session:'))
      onPrepareSession(key.slice('session:'.length));
  };
  return (
    <div
      ref={root}
      className={css.root}
      data-collapsed={collapsed || undefined}
      role="tree"
      aria-label="员工与工作"
      onPointerOver={(event) => prepareSession(event.target)}
      onFocusCapture={(event) => prepareSession(event.target)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && rail) {
          event.stopPropagation();
          setRail(null);
        }
      }}
    >
      {groups.map((group) => {
        const employee = employeeChoice(workspace, group.key);
        const profile = employeeChoiceProfile(workspace, group.key);
        const role = profile?.identity.role;
        const color = employee?.currentVersion.manifest.appearance?.accentColor;
        const accent = employeeAccent(group.label, color);
        const history = sessions.filter(
          (session) =>
            sessionEmployeeKey(session) === group.key &&
            (archive?.filter === 'show' ||
              (archive?.filter === 'only'
                ? !!session.archivedAt
                : !session.archivedAt)),
        );
        const preview = employeeSessionPreview(group.sessions, activeId);
        const rows = all[group.key] ? group.sessions : preview.rows;
        const pagination = archive?.employeePages?.[group.key];
        const needsPreview =
          !!archive &&
          group.sessions.length <
            Math.min(employeeSessionPreviewLimit, group.sessionCount) &&
          (!pagination || pagination.loading || !!pagination.error);
        const hasMore = archive?.hasMore(group.key);
        const remaining = Math.max(0, group.sessionCount - rows.length);
        if (collapsed)
          return (
            <div
              className={css.railItem}
              key={group.key}
              onMouseEnter={() => setRail(group.key)}
              onMouseLeave={() => setRail(null)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setRail(null);
              }}
            >
              <button
                type="button"
                className={css.avatar}
                data-accent={accent}
                style={employeeAccentStyle(group.label, color)}
                aria-label={group.label}
                aria-expanded={rail === group.key}
                onFocus={() => setRail(group.key)}
                onClick={() => setRail(group.key)}
              >
                {Array.from(group.label)[0]}
              </button>
              {rail === group.key && (
                <div
                  className={css.flyout}
                  role="group"
                  aria-label={`${group.label}的工作`}
                >
                  <strong>{group.label}</strong>
                  <small>{role}</small>
                  {history.slice(0, 3).map((session) => (
                    <button
                      type="button"
                      key={session.id}
                      onPointerEnter={() => onPrepareSession(session.id)}
                      onFocus={() => onPrepareSession(session.id)}
                      onClick={() => {
                        setRail(null);
                        onSelectSession(session.id);
                      }}
                    >
                      {session.title}
                    </button>
                  ))}
                  {profile && (
                    <button type="button" onClick={() => onDetails(group.key)}>
                      查看员工详情
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        return (
          <section
            key={group.key}
            className={css.group}
            aria-label={group.label}
          >
            <div
              className={css.employeeCard}
              data-accent={accent}
              style={employeeAccentStyle(group.label, color)}
              data-active={group.containsCurrent || undefined}
            >
              <div className={css.header}>
                <ProjectRowItem
                  group={group}
                  title={
                    <span className={css.employeeTitle}>
                      <span className={css.employeeName}>{group.label}</span>
                      {employee?.isDefault && (
                        <span className={css.defaultLabel}>默认</span>
                      )}
                      <IconChevronDownOutlineRegular
                        className={css.expandIcon}
                        size={12}
                      />
                    </span>
                  }
                  description={
                    <span className={css.meta}>
                      {role && (
                        <span className={css.employeeRole}>{role} · </span>
                      )}
                      <span>{group.sessionCount} 个工作</span>
                    </span>
                  }
                  leading={
                    <span className={css.initial}>
                      {Array.from(group.label)[0]}
                    </span>
                  }
                  onToggle={() =>
                    setExpansion((current) => ({
                      ...current,
                      [group.key]: !group.expanded,
                    }))
                  }
                  t={employeeTranslate}
                />
                {profile && (
                  <button
                    type="button"
                    className={css.info}
                    aria-label={`查看${group.label}详情`}
                    title={`${group.label}介绍`}
                    onClick={() => onDetails(group.key)}
                  >
                    <span>详情</span>
                    <IconChevronRightOutlineRegular size={13} />
                  </button>
                )}
              </div>
            </div>
            {group.expanded && (
              <div
                role="group"
                aria-label={`${group.label}的会话`}
                className={css.sessions}
              >
                {rows.map((node) => (
                  <SessionNodeItem
                    key={node.id}
                    node={node}
                    leading={
                      scheduledSessions?.has(node.id) ? (
                        <span
                          title="有启用中的自动化任务"
                          aria-label="有启用中的自动化任务"
                        >
                          <IconClockOutlineRegular size={14} />
                        </span>
                      ) : reads[node.id] === 'error' ? (
                        <span
                          title="子智能体状态读取失败"
                          aria-label="子智能体状态读取失败"
                        >
                          ?
                        </span>
                      ) : nativeSubagentActivityUnknown(reads[node.id]) ? (
                        <span
                          title="子智能体当前活动状态未知"
                          aria-label="子智能体当前活动状态未知"
                        >
                          ?
                        </span>
                      ) : undefined
                    }
                    currentId={activeId ?? undefined}
                    now={Date.now()}
                    onOpen={onSelectSession}
                    renderSlot={
                      sessions.some(
                        (s) =>
                          s.id === node.id &&
                          s.ownerId &&
                          s.ownerId !== workspace.viewerId,
                      )
                        ? undefined
                        : archive?.renderActions
                    }
                    t={employeeTranslate}
                  />
                ))}
                {group.sessionCount === 0 && (
                  <span className={css.empty}>从顶部「新的工作」开始</span>
                )}
                {needsPreview && !pagination?.error && (
                  <span role="status" className={css.empty}>
                    正在加载会话…
                  </span>
                )}
                {((!needsPreview &&
                  (group.sessions.length > rows.length || hasMore)) ||
                  pagination?.error) && (
                  <button
                    className={css.more}
                    type="button"
                    disabled={archive?.loading || pagination?.loading}
                    onClick={() => {
                      if (needsPreview) {
                        archive?.loadPreview(group.key);
                        return;
                      }
                      setAll((current) => ({ ...current, [group.key]: true }));
                      if (hasMore) archive?.loadMore(group.key);
                    }}
                  >
                    {pagination?.loading
                      ? '正在加载会话…'
                      : pagination?.error
                        ? '加载失败，点击重试'
                        : remaining > 0
                          ? `展开其余 ${remaining} 个会话`
                          : '展开更多会话'}
                  </button>
                )}
                {pagination?.error && (
                  <span role="alert" className={css.empty}>
                    {pagination.error}
                  </span>
                )}
                {all[group.key] && preview.hiddenCount > 0 && (
                  <button
                    className={css.more}
                    type="button"
                    onClick={() =>
                      setAll((current) => ({ ...current, [group.key]: false }))
                    }
                  >
                    收起更多会话
                  </button>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
