'use client';

import { useEffect, useRef } from 'react';
import { AllriceBrand } from '../../components/allrice-brand';
import { AllriceMark } from '../../components/allrice-mark';

import type { SaasCapabilityManifest } from '@allrice/contracts';
import { SidebarSettings } from './sidebar-settings';
import type { useMonthlyQuota } from './use-monthly-quota';
import type { usePersonalPreferences } from './use-personal-preferences';

import type { Session, Workspace } from './chatflow-types';
import { EmployeeSidebar } from './employee-sidebar';
import { employeePreferenceKey } from './employee-navigation';
import frameUi from './dsh-upstream/AppFrame.module.css';
import sidebarUi from './dsh-upstream/SidebarRoot.module.css';
import styles from './dsh-saas.module.css';

interface ChatSidebarProps {
  activeId: string | null;
  collapsed: boolean;
  overlay?: boolean;
  manifest: SaasCapabilityManifest;
  sessions: Session[];
  workspace: Workspace;
  monthlyQuota: ReturnType<typeof useMonthlyQuota>;
  preferences: ReturnType<typeof usePersonalPreferences>;
  providerLabel: string;
  settingsSection: string | null;
  onSettingsSectionChange: (section: string | null) => void;
  onBridge: () => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onNewSession: (assignmentId?: string) => void;
  onOpenEmployeeDetails: (assignmentId?: string) => void;
  onSelectSession: (sessionId: string) => void;
  onPrepareSession: (sessionId: string) => void;
}

export function ChatSidebar({
  activeId,
  collapsed,
  overlay = false,
  manifest,
  sessions,
  workspace,
  monthlyQuota,
  preferences,
  providerLabel,
  settingsSection,
  onSettingsSectionChange,
  onBridge,
  onCollapsedChange,
  onNewSession,
  onOpenEmployeeDetails,
  onSelectSession,
  onPrepareSession,
}: ChatSidebarProps) {
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!overlay) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    sidebar.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [overlay]);

  return (
    <aside
      id="chat-sidebar"
      ref={sidebar}
      tabIndex={overlay ? -1 : undefined}
      role={overlay ? 'dialog' : undefined}
      aria-label={overlay ? '任务与历史' : undefined}
      aria-modal={overlay ? true : undefined}
      className={`${frameUi.sidebarCol} ${overlay ? styles.sidebarOverlay : ''}`}
      onKeyDown={(event) => {
        if (!overlay || !event.currentTarget.contains(event.target as Node))
          return;
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCollapsedChange(true);
        }
        if (event.key === 'Tab') {
          const nodes = [
            ...sidebar.current!.querySelectorAll<HTMLElement>(
              'button:not([disabled]),a[href],summary',
            ),
          ].filter(
            (n) =>
              n.getClientRects().length &&
              (!n.closest('details:not([open])') || n.tagName === 'SUMMARY'),
          );
          const first = nodes[0],
            last = nodes.at(-1);
          if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === sidebar.current)
          ) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      {overlay ? (
        <div
          className={styles.sidebarBackdrop}
          aria-hidden="true"
          onClick={() => onCollapsedChange(true)}
        />
      ) : null}
      <div
        className={`${sidebarUi.root} ${
          collapsed ? sidebarUi.collapsed : styles.sidebar
        }`}
      >
        <div className={sidebarUi.logoRow}>
          {!collapsed ? (
            <button
              aria-label="开始新的工作"
              className={sidebarUi.brand}
              onClick={() => onNewSession()}
              type="button"
            >
              <AllriceBrand />
            </button>
          ) : null}
          <button
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            className={`${sidebarUi.iconButton} ${sidebarUi.toggle}`}
            onClick={() => onCollapsedChange(!collapsed)}
            type="button"
          >
            {collapsed ? (
              <>
                <span className={`${sidebarUi.railMark} ${styles.railMark}`}>
                  <AllriceMark />
                </span>
                <span
                  aria-hidden="true"
                  className={`${sidebarUi.panelIcon} ${styles.sidebarToggle}`}
                >
                  ›
                </span>
              </>
            ) : (
              <span aria-hidden="true" className={styles.sidebarToggle}>
                ‹
              </span>
            )}
          </button>
        </div>

        <button
          className={sidebarUi.newSession}
          onClick={() => onNewSession()}
          type="button"
        >
          <span aria-hidden="true">＋</span>
          <span className={sidebarUi.newSessionLabel}>新的工作</span>
        </button>

        <div className={sidebarUi.regionArea}>
          <EmployeeSidebar
            key={
              employeePreferenceKey(workspace) ??
              `${workspace.organizationId}:${workspace.workspaceId}`
            }
            workspace={workspace}
            sessions={sessions}
            activeId={activeId}
            collapsed={collapsed}
            onSelectSession={onSelectSession}
            onPrepareSession={onPrepareSession}
            onDetails={onOpenEmployeeDetails}
          />
        </div>

        <div className={sidebarUi.footArea}>
          <SidebarSettings
            key={
              employeePreferenceKey(workspace) ??
              `${workspace.organizationId}:${workspace.workspaceId}`
            }
            collapsed={collapsed}
            manifest={manifest}
            workspaceId={workspace.workspaceId}
            monthlyQuota={monthlyQuota}
            preferences={preferences}
            providerLabel={providerLabel}
            section={settingsSection}
            onSectionChange={onSettingsSectionChange}
            onBridge={onBridge}
          />
        </div>
      </div>
    </aside>
  );
}
