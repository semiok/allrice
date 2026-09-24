'use client';
import { useEffect, useMemo, useState } from 'react';
import type { Session, Workspace } from './chatflow-types';
import { ProjectRowItem, SessionNodeItem } from './dsh-upstream/workspace/Rows';
import { collapsedSessionRows } from './dsh-upstream/workspace/collapsed-session-rows';
import {
  employeeGroups,
  employeePreferenceKey,
  employeeTranslate,
  readEmployeeExpansion,
} from './employee-navigation';
import css from './employee-sidebar.module.css';

export function EmployeeSidebar({
  workspace,
  sessions,
  activeId,
  collapsed,
  onSelectSession,
  onPrepareSession,
  onDetails,
}: {
  workspace: Workspace;
  sessions: Session[];
  activeId: string | null;
  collapsed: boolean;
  onSelectSession: (id: string) => void;
  onPrepareSession: (id: string) => void;
  onDetails: (assignmentId: string) => void;
}) {
  const key = employeePreferenceKey(workspace);
  const [expansion, setExpansion] = useState(() => readEmployeeExpansion(key));
  const [all, setAll] = useState<Record<string, boolean>>({});
  const [rail, setRail] = useState<string | null>(null);
  const activeGroup = sessions.find(
    (session) => session.id === activeId,
  )?.employeeAssignmentId;
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
    () => employeeGroups(workspace, sessions, activeId, expansion),
    [workspace, sessions, activeId, expansion],
  );
  if (!groups.length) return <p className={css.empty}>当前没有可用员工</p>;
  const prepareSession = (target: EventTarget) => {
    if (!(target instanceof Element)) return;
    const key = target.closest('[data-row-key]')?.getAttribute('data-row-key');
    if (key?.startsWith('session:'))
      onPrepareSession(key.slice('session:'.length));
  };
  return (
    <div
      className={css.root}
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
        const employee = workspace.employees.find(
          (item) => item.id === group.key,
        );
        const profile = workspace.employeeProfiles.find(
          (item) => item.assignmentId === group.key,
        );
        const role = profile?.identity.role;
        const accent = /office/i.test(group.label) ? 'orange' : 'blue';
        const history = sessions.filter(
          (session) => session.employeeAssignmentId === group.key,
        );
        const native = collapsedSessionRows(group.sessions);
        // Navigation must reveal the selected row even when it is older than five.
        const rows = all[group.key]
          ? group.sessions
          : group.sessions.filter(
              (row) => native.rows.includes(row) || row.id === activeId,
            );
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
                aria-label={group.label}
                aria-expanded={rail === group.key}
                onFocus={() => setRail(group.key)}
                onClick={() => setRail(group.key)}
              >
                {group.label.slice(0, 1)}
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
              data-active={group.containsCurrent || undefined}
            >
              <div className={css.header}>
                <ProjectRowItem
                  group={group}
                  leading={
                    <span className={css.initial}>
                      {group.label.slice(0, 1)}
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
                    ⓘ
                  </button>
                )}
              </div>
              <div className={css.meta}>
                <span>
                  {[
                    role,
                    employee?.isDefault ? '默认' : null,
                    `${group.sessionCount} 个工作`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
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
                    currentId={activeId ?? undefined}
                    now={Date.now()}
                    onOpen={onSelectSession}
                    t={employeeTranslate}
                  />
                ))}
                {group.sessionCount === 0 && (
                  <span className={css.empty}>从顶部「新的工作」开始</span>
                )}
                {group.sessions.length > rows.length && (
                  <button
                    className={css.more}
                    type="button"
                    onClick={() =>
                      setAll((current) => ({ ...current, [group.key]: true }))
                    }
                  >
                    展开其余 {group.sessions.length - rows.length} 个会话
                  </button>
                )}
                {all[group.key] && native.hiddenCount > 0 && (
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
