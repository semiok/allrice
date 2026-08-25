'use client';

import Link from 'next/link';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';

import { AutomationClient } from '../automation/automation-client';
import { EmployeeHubClient } from '../employees/employeehub-client';
import { WorkspaceClient } from '../workspace/workspace-client';
import { AppSidebar, type AppNavKey } from './app-sidebar';

export type AppPanel = AppNavKey;

export interface WorkspaceSidebarSession {
  id: string;
  title: string;
  employeeVersionId: string;
  updatedAt: string;
}

export interface WorkspaceSidebarGroup {
  id: string;
  name: string;
  sessions: WorkspaceSidebarSession[];
}

export interface WorkspaceSidebarSnapshot {
  groups: WorkspaceSidebarGroup[];
  activeId: string | null;
  canAdminister: boolean;
}

interface AppShellContextValue {
  activePanel: AppPanel;
  navigate: (panel: AppPanel) => void;
}

const AppShellContext = createContext<AppShellContextValue | null>(null);

export function useAppShell() {
  return useContext(AppShellContext);
}

function panelFromPathname(pathname: string | null): AppPanel | null {
  if (pathname === '/automation') return 'automation';
  if (pathname === '/employees') return 'employees';
  if (pathname === '/workspace' || pathname === '/') return 'workspace';
  return null;
}

function WorkspaceSidebar({
  snapshot,
  onSelectSession,
}: {
  snapshot: WorkspaceSidebarSnapshot | null;
  onSelectSession: (sessionId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  return (
    <>
      <p className="sidebar-section-title">AI员工工作</p>
      <nav className="employee-work-nav" aria-label="AI员工工作区">
        {snapshot?.groups.map((group) => {
          const isCollapsed = collapsed.has(group.id);
          return (
            <section className="employee-work-group" key={group.id}>
              <button
                className="employee-work-heading"
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })
                }
              >
                <span className="employee-work-chevron">
                  {isCollapsed ? '›' : '⌄'}
                </span>
                <span className="primary-menu-icon">◌</span>
                <span>与 {group.name} 工作</span>
              </button>
              {!isCollapsed ? (
                <div
                  className="employee-session-list"
                  aria-label={`${group.name}的对话`}
                >
                  {group.sessions.map((session) => (
                    <button
                      className={
                        session.id === snapshot.activeId ? 'session-active' : ''
                      }
                      key={session.id}
                      type="button"
                      onClick={() => onSelectSession(session.id)}
                    >
                      <strong>{session.title}</strong>
                      <span>
                        最近工作 ·{' '}
                        {new Date(session.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                  ))}
                  {group.sessions.length === 0 ? (
                    <span className="employee-group-empty">暂无对话</span>
                  ) : null}
                </div>
              ) : null}
            </section>
          );
        })}
        {!snapshot ? (
          <span className="employee-group-empty">正在加载工作记录…</span>
        ) : null}
      </nav>
    </>
  );
}

export function AppShell({ initialPanel }: { initialPanel: AppPanel }) {
  const pathname = usePathname();
  const routePanel = useMemo(() => panelFromPathname(pathname), [pathname]);
  const [activePanel, setActivePanel] = useState<AppPanel>(initialPanel);
  const [workspaceSidebar, setWorkspaceSidebar] =
    useState<WorkspaceSidebarSnapshot | null>(null);

  useEffect(() => {
    if (routePanel && routePanel !== initialPanel) setActivePanel(routePanel);
  }, [initialPanel, routePanel]);

  useEffect(() => {
    const receiveWorkspaceSidebar = (event: Event) => {
      setWorkspaceSidebar(
        (event as CustomEvent<WorkspaceSidebarSnapshot>).detail,
      );
    };
    window.addEventListener(
      'allrice:workspace-sidebar',
      receiveWorkspaceSidebar,
    );
    return () =>
      window.removeEventListener(
        'allrice:workspace-sidebar',
        receiveWorkspaceSidebar,
      );
  }, []);

  function requestWorkspaceAction(action: 'new' | 'files' | 'memory') {
    window.dispatchEvent(
      new CustomEvent('allrice:workspace-action', { detail: { action } }),
    );
  }

  function selectSession(sessionId: string) {
    setActivePanel('workspace');
    window.dispatchEvent(
      new CustomEvent('allrice:workspace-action', {
        detail: { action: 'select-session', sessionId },
      }),
    );
  }

  async function logout() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  }

  return (
    <AppShellContext.Provider value={{ activePanel, navigate: setActivePanel }}>
      <main className="app-shell">
        <AppSidebar
          active={activePanel}
          action={
            <button
              className="new-chat"
              type="button"
              onClick={() => {
                setActivePanel('workspace');
                requestWorkspaceAction('new');
              }}
            >
              ＋ 新建任务
            </button>
          }
          className="app-shell-sidebar"
          onFiles={() => requestWorkspaceAction('files')}
          onMemory={() => requestWorkspaceAction('memory')}
          onNavigate={setActivePanel}
          showEmployeeAdmin={workspaceSidebar?.canAdminister ?? false}
        >
          <WorkspaceSidebar
            snapshot={workspaceSidebar}
            onSelectSession={selectSession}
          />
          {workspaceSidebar?.canAdminister ? (
            <Link className="text-action" href="/skillhub">
              管理 AI员工技能
            </Link>
          ) : null}
          <button className="text-action" type="button" onClick={logout}>
            退出登录
          </button>
        </AppSidebar>

        <section className="app-shell-content">
          <div className="app-shell-panel" hidden={activePanel !== 'workspace'}>
            <WorkspaceClient hideSidebar />
          </div>
          <div
            className="app-shell-panel"
            hidden={activePanel !== 'automation'}
          >
            <AutomationClient embedded />
          </div>
          <div className="app-shell-panel" hidden={activePanel !== 'employees'}>
            <EmployeeHubClient embedded />
          </div>
        </section>
      </main>
    </AppShellContext.Provider>
  );
}
