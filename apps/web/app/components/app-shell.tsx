'use client';

import Link from 'next/link';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname } from 'next/navigation';

import {
  resolveFrameworkRollout,
  type FrameworkRolloutPolicy,
} from '@allrice/contracts';

import { ModelPoolClient } from '../admin/model-pool-client';
import { AutomationClient } from '../automation/automation-client';
import { EmployeeHubClient } from '../employees/employeehub-client';
import { WorkspaceClient } from '../workspace/workspace-client';
import type { AppNavKey } from './app-sidebar';

export type AppPanel = AppNavKey;

const AppShellContext = createContext<{
  activePanel: AppPanel;
  navigate: (panel: AppPanel) => void;
} | null>(null);

export function useAppShell() {
  const context = useContext(AppShellContext);
  return (
    context ?? {
      activePanel: 'workspace' as const,
      navigate: () => undefined,
    }
  );
}

export interface WorkspaceSidebarSession {
  id: string;
  title: string;
  employeeVersionId: string;
  harness: 'codex' | 'dsh';
  updatedAt: string;
}

export interface WorkspaceSidebarGroup {
  id: string;
  name: string;
  sessions: WorkspaceSidebarSession[];
}

export interface WorkspaceSidebarSnapshot {
  organizationId: string;
  workspaceId: string;
  employeeVersionId: string | null;
  groups: WorkspaceSidebarGroup[];
  activeId: string | null;
  canAdminister: boolean;
}

interface SaasCapabilities {
  roles: Array<'member' | 'tenant_admin' | 'platform_admin'>;
}

function panelFromPathname(pathname: string | null): AppPanel | null {
  if (pathname === '/automation') return 'automation';
  if (pathname === '/employees') return 'employees';
  if (pathname === '/admin/models') return 'model-pool';
  if (pathname === '/workspace' || pathname === '/') return 'workspace';
  return null;
}

function SessionDirectory({
  snapshot,
  onSelect,
}: {
  snapshot: WorkspaceSidebarSnapshot | null;
  onSelect: (id: string) => void;
}) {
  if (!snapshot) return <p className="v2-sidebar-empty">正在恢复会话…</p>;
  return (
    <div className="v2-session-directory">
      {snapshot.groups.map((group) => (
        <section key={group.id}>
          <div className="v2-session-group-title">
            <span>{group.name}</span>
            <em>{group.sessions.length}</em>
          </div>
          {group.sessions.map((session) => (
            <button
              type="button"
              key={session.id}
              className={session.id === snapshot.activeId ? 'active' : ''}
              onClick={() => onSelect(session.id)}
            >
              <span className="v2-session-title">{session.title}</span>
              <span className="v2-session-subtitle">
                <em className="v2-harness v2-harness-dsh">DSH</em>
                {new Date(session.updatedAt).toLocaleDateString()}
              </span>
            </button>
          ))}
          {group.sessions.length === 0 ? (
            <p className="v2-sidebar-empty">暂无对话</p>
          ) : null}
        </section>
      ))}
    </div>
  );
}

export function AppShell({
  initialPanel,
  rolloutPolicy,
}: {
  initialPanel: AppPanel;
  rolloutPolicy: FrameworkRolloutPolicy;
}) {
  const pathname = usePathname();
  const routePanel = useMemo(() => panelFromPathname(pathname), [pathname]);
  const [activePanel, setActivePanel] = useState<AppPanel>(initialPanel);
  const [workspaceSidebar, setWorkspaceSidebar] =
    useState<WorkspaceSidebarSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<SaasCapabilities>({
    roles: ['member'],
  });

  useEffect(() => {
    if (routePanel && routePanel !== initialPanel) setActivePanel(routePanel);
  }, [initialPanel, routePanel]);

  useEffect(() => {
    void fetch('/api/v1/saas/capabilities')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { capabilities?: SaasCapabilities } | null) => {
        if (body?.capabilities) setCapabilities(body.capabilities);
      });
  }, []);

  useEffect(() => {
    const receive = (event: Event) =>
      setWorkspaceSidebar(
        (event as CustomEvent<WorkspaceSidebarSnapshot>).detail,
      );
    window.addEventListener('allrice:workspace-sidebar', receive);
    return () =>
      window.removeEventListener('allrice:workspace-sidebar', receive);
  }, []);

  useEffect(() => {
    const enabled = resolveFrameworkRollout(rolloutPolicy, {
      organizationId: workspaceSidebar?.organizationId,
      workspaceId: workspaceSidebar?.workspaceId,
      employeeVersionId: workspaceSidebar?.employeeVersionId,
      surface: activePanel,
    });
    document.documentElement.dataset.allriceFramework = enabled
      ? 'v2'
      : 'legacy';
  }, [activePanel, rolloutPolicy, workspaceSidebar]);

  function workspaceAction(
    action: 'new' | 'select-session',
    sessionId?: string,
  ) {
    setActivePanel('workspace');
    window.dispatchEvent(
      new CustomEvent('allrice:workspace-action', {
        detail: { action, ...(sessionId ? { sessionId } : {}) },
      }),
    );
  }

  async function logout() {
    await fetch('/api/v1/auth/logout', { method: 'POST' });
    window.location.assign('/login');
  }

  const platformAdmin = capabilities.roles.includes('platform_admin');
  const tenantAdmin =
    capabilities.roles.includes('tenant_admin') ||
    workspaceSidebar?.canAdminister;

  return (
    <AppShellContext.Provider value={{ activePanel, navigate: setActivePanel }}>
      <main className="v2-app-shell">
        <aside className="v2-app-sidebar">
          <div className="v2-brand">
            <span className="v2-brand-mark">A</span>
            <span>
              <strong>AllRice</strong>
              <small>工作伙伴</small>
            </span>
          </div>

          <button
            className="v2-new-task"
            type="button"
            onClick={() => workspaceAction('new')}
          >
            <span>＋</span> 新任务
          </button>

          <nav className="v2-main-nav" aria-label="主导航">
            <button
              type="button"
              className={activePanel === 'workspace' ? 'active' : ''}
              onClick={() => setActivePanel('workspace')}
            >
              <span>◈</span> 与 Rice 工作
            </button>
          </nav>

          <div className="v2-sidebar-section-heading">
            <span>最近对话</span>
            <button type="button" onClick={() => workspaceAction('new')}>
              ＋
            </button>
          </div>
          <SessionDirectory
            snapshot={workspaceSidebar}
            onSelect={(id) => workspaceAction('select-session', id)}
          />

          {tenantAdmin ? (
            <nav className="v2-admin-nav" aria-label="管理控制台">
              <span className="v2-nav-label">管理</span>
              <button
                type="button"
                className={activePanel === 'employees' ? 'active' : ''}
                onClick={() => setActivePanel('employees')}
              >
                <span>◇</span> AI 员工
              </button>
              <Link href="/skillhub">
                <span>⌘</span> SkillHub
              </Link>
              <button
                type="button"
                className={activePanel === 'model-pool' ? 'active' : ''}
                onClick={() => setActivePanel('model-pool')}
              >
                <span>◎</span> 模型与运行
              </button>
            </nav>
          ) : null}

          <footer className="v2-sidebar-footer">
            <div className="v2-account">
              <span className="v2-account-avatar">S</span>
              <span>
                <strong>
                  {platformAdmin
                    ? '平台管理员'
                    : tenantAdmin
                      ? '租户管理员'
                      : '成员'}
                </strong>
                <small>{platformAdmin ? 'Platform' : 'Workspace'}</small>
              </span>
            </div>
            <button type="button" onClick={logout} aria-label="退出登录">
              ↗
            </button>
          </footer>
        </aside>

        <section className="v2-app-content">
          <div className="v2-app-panel" hidden={activePanel !== 'workspace'}>
            <WorkspaceClient hideSidebar />
          </div>
          <div className="v2-app-panel" hidden={activePanel !== 'employees'}>
            <EmployeeHubClient embedded />
          </div>
          <div className="v2-app-panel" hidden={activePanel !== 'model-pool'}>
            <ModelPoolClient />
          </div>
          <div className="v2-app-panel" hidden={activePanel !== 'automation'}>
            <AutomationClient embedded />
          </div>
        </section>
      </main>
    </AppShellContext.Provider>
  );
}
