'use client';
import type { ReactNode } from 'react';
import { SidebarSettings } from './sidebar-settings';
import type { useMonthlyQuota } from './use-monthly-quota';
import type { usePersonalPreferences } from './use-personal-preferences';
import type { useBridge } from './use-bridge';
import type { useBridgeReleases } from './bridge-releases';
import type { Session, Workspace } from './chatflow-types';
import type { useSessionArchive } from './use-session-archive';
import { EmployeeSidebar } from './employee-sidebar';
import { employeePreferenceKey } from './employee-navigation';
import type { NativeSubagentRead } from './use-native-subagents';
import { ChatSidebarFrame } from './chat-sidebar-frame';

interface ChatSidebarProps {
  capabilities: (section: 'work' | 'computer') => ReactNode;
  archive?: ReturnType<typeof useSessionArchive>;
  activeId: string | null;
  nativeReadyKey?: string;
  pendingNativeSessions?: ReadonlySet<string>;
  nativeReads?: Record<string, NativeSubagentRead>;
  collapsed: boolean;
  overlay?: boolean;
  sessions: Session[];
  workspace: Workspace;
  monthlyQuota: ReturnType<typeof useMonthlyQuota>;
  preferences: ReturnType<typeof usePersonalPreferences>;
  settingsSection: string | null;
  onSettingsSectionChange: (section: string | null) => void;
  onBridge: () => void;
  bridge: ReturnType<typeof useBridge>;
  bridgeReleases: ReturnType<typeof useBridgeReleases>;
  onCapabilitiesChange: () => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onCreateEmployee: () => void;
  onNewSession: (assignmentId: string) => void;
  pendingEmployeeAssignmentId?: string | null;
  onOpenEmployeeDetails: (assignmentId?: string) => void;
  onSelectSession: (sessionId: string) => void;
  onEmployeeNavigate?: (instanceId: string) => void;
  onPrepareSession: (sessionId: string) => void;
  onOpenAutomations?: () => void;
  automationsActive?: boolean;
  scheduledSessions?: ReadonlySet<string>;
  onOpenArchive?: () => void;
  employeeArchiveOpen?: boolean;
  archivedEmployeeInstanceIds?: ReadonlySet<string>;
}

export function ChatSidebar({
  capabilities,
  archive,
  activeId,
  nativeReadyKey,
  pendingNativeSessions,
  nativeReads,
  collapsed,
  overlay = false,
  sessions,
  workspace,
  monthlyQuota,
  preferences,
  settingsSection,
  onSettingsSectionChange,
  onBridge,
  bridge,
  bridgeReleases,
  onCapabilitiesChange,
  onCollapsedChange,
  onCreateEmployee,
  onNewSession,
  pendingEmployeeAssignmentId,
  onOpenEmployeeDetails,
  onSelectSession,
  onEmployeeNavigate,
  onPrepareSession,
  onOpenAutomations,
  automationsActive = false,
  scheduledSessions,
  onOpenArchive,
  employeeArchiveOpen = false,
  archivedEmployeeInstanceIds,
}: ChatSidebarProps) {
  return (
    <ChatSidebarFrame
      archive={archive}
      collapsed={collapsed}
      overlay={overlay}
      onCollapsedChange={onCollapsedChange}
      onCreateEmployee={onCreateEmployee}
      onOpenAutomations={onOpenAutomations}
      automationsActive={automationsActive}
      onOpenArchive={onOpenArchive}
      employeeArchiveOpen={employeeArchiveOpen}
      employeeTree={
        <EmployeeSidebar
          scheduledSessions={scheduledSessions}
          archive={archive}
          excludedEmployeeInstanceIds={archivedEmployeeInstanceIds}
          key={
            employeePreferenceKey(workspace) ??
            `${workspace.organizationId}:${workspace.workspaceId}`
          }
          workspace={workspace}
          sessions={sessions}
          activeId={activeId}
          pendingEmployeeAssignmentId={pendingEmployeeAssignmentId}
          onNewSession={(id) => {
            archive?.setFilter('default');
            onNewSession(id);
          }}
          nativeReadyKey={nativeReadyKey}
          pendingNativeSessions={pendingNativeSessions}
          nativeReads={nativeReads}
          collapsed={collapsed}
          onSelectSession={onSelectSession}
          onEmployeeNavigate={onEmployeeNavigate}
          onPrepareSession={onPrepareSession}
          onDetails={onOpenEmployeeDetails}
        />
      }
      settings={
        <SidebarSettings
          sessionId={activeId ?? undefined}
          capabilities={capabilities}
          key={
            employeePreferenceKey(workspace) ??
            `${workspace.organizationId}:${workspace.workspaceId}`
          }
          collapsed={collapsed}
          workspaceId={workspace.workspaceId}
          monthlyQuota={monthlyQuota}
          preferences={preferences}
          section={settingsSection}
          onSectionChange={onSettingsSectionChange}
          onBridge={onBridge}
          bridge={bridge}
          bridgeReleases={bridgeReleases}
          onCapabilitiesChange={onCapabilitiesChange}
        />
      }
    />
  );
}
