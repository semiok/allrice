import { useSyncExternalStore, type ComponentProps } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import type { SidebarOwnerProps } from '@deepseek-ai/dsh-client-ui-layout/client';
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type { SettingsLauncherOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client';
import { ChatSidebarFrame } from '../../../apps/web/app/chatflow/chat-sidebar-frame';
import { EmployeeSidebarView } from '../../../apps/web/app/chatflow/employee-sidebar-view';
import {
  SidebarSettingsButton,
  SidebarSettingsTrigger,
} from '../../../apps/web/app/chatflow/sidebar-settings-trigger';
import '@allrice/ui/tokens.css';
import '../../../apps/web/app/styles/sidebar-palette.css';

const compactQuery = '(max-width: 760px)';
const compactSnapshot = () => window.matchMedia(compactQuery).matches;
const subscribeCompact = (listener: () => void) => {
  const media = window.matchMedia(compactQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
};

type Tree = ComponentProps<typeof EmployeeSidebarView>;
type Frame = ComponentProps<typeof ChatSidebarFrame>;

/** Business projection and operations supplied by the authenticated AllRice owner. */
export interface EmployeeSidebarSnapshot {
  tree: Omit<Tree, 'collapsed' | 'onVisibleSessionsChange' | 'archive'> &
    Required<Pick<Tree, 'onNewSession' | 'onDetails' | 'onEmployeeNavigate'>>;
  archive: NonNullable<Frame['archive']>;
  employeeArchiveOpen?: boolean;
  settingsOpen: boolean;
  /** Existing owner failure. Absence means no navigation error is being shown. */
  error?: string;
}

export interface EmployeeSidebarPort {
  getSnapshot: () => EmployeeSidebarSnapshot;
  subscribe: (listener: () => void) => () => void;
  createEmployee: () => void;
  openArchive: () => void;
  /** MET-279 supplies the employee settings surface; never an admin route. */
  openEmployeeSettings: () => void;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    allriceEmployeeSidebar: EmployeeSidebarPort;
  }
}

/** The owner must supply live commands. No product fixture/default port exists. */
export function EmployeeSidebar({
  ctx,
  collapsed,
  renderSlot,
}: SidebarOwnerProps &
  PropsRenderSlots<'sidebar.settings'> & { ctx: Context }) {
  const port = ctx.allriceEmployeeSidebar;
  const snapshot = useSyncExternalStore(port.subscribe, port.getSnapshot);
  const panel = useSyncExternalStore(
    ctx.layout.panelInfo.subscribe,
    ctx.layout.panelInfo.getSnapshot,
  );
  const compact = useSyncExternalStore(
    subscribeCompact,
    compactSnapshot,
    () => false,
  );
  const closeMobile = () => {
    if (compact && !collapsed) ctx.layout.toggleSidebar();
  };
  return (
    <ChatSidebarFrame
      archive={snapshot.archive}
      employeeArchiveOpen={snapshot.employeeArchiveOpen}
      collapsed={collapsed}
      overlay={compact && !collapsed}
      style={{ height: '100%' }}
      onCollapsedChange={() => ctx.layout.toggleSidebar()}
      onCreateEmployee={port.createEmployee}
      onOpenArchive={port.openArchive}
      onOpenAutomations={() => {
        ctx.layout.selectPanel(
          'schedules' as Parameters<typeof ctx.layout.selectPanel>[0],
        );
        closeMobile();
      }}
      automationsActive={panel.activePanelId === 'schedules'}
      employeeTree={
        <>
          {snapshot.error && <p role="alert">{snapshot.error}</p>}
          <EmployeeSidebarView
            {...snapshot.tree}
            archive={snapshot.archive}
            collapsed={collapsed}
            onNewSession={(id) => {
              snapshot.archive.setFilter('default');
              snapshot.tree.onNewSession(id);
              closeMobile();
            }}
            onSelectSession={(id) => {
              snapshot.tree.onSelectSession(id);
              closeMobile();
            }}
          />
        </>
      }
      settings={renderSlot('sidebar.settings', { wide: !collapsed })}
    />
  );
}

/** Registers only after the real owner port and native layout are available. */
export function apply(ctx: Context) {
  ctx.inject(['allriceEmployeeSidebar', 'layout'], (scope) => {
    scope.slots.inject('sidebar', () =>
      scope.slots.register(
        {
          name: 'sidebar',
          priority: -100,
          children: { 'sidebar.settings': { kind: 'single', scope: 'root' } },
        },
        (props: SidebarOwnerProps & PropsRenderSlots<'sidebar.settings'>) => (
          <EmployeeSidebar {...props} ctx={scope} />
        ),
      ),
    );
  });
}

/** Called by the authenticated owner plugin in its own Cordis lifetime. */
export function bindEmployeeSidebar(ctx: Context, port: EmployeeSidebarPort) {
  ctx.provide('allriceEmployeeSidebar', port);
}

/** Native SettingsRoot supplies the row and the authoritative open/state. */
export function AllRiceSettingsLauncher({
  wide,
  settingsOpen,
  openSettings,
}: SettingsLauncherOwnerProps) {
  return (
    <SidebarSettingsButton
      collapsed={!wide}
      expanded={settingsOpen}
      onOpen={openSettings}
    />
  );
}

export { ChatSidebarFrame, EmployeeSidebarView, SidebarSettingsTrigger };
export { EmployeeClientNavigation } from './employee-client.mjs';
