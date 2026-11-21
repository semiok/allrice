import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatSidebar } from '../../../../apps/web/app/chatflow/chat-sidebar';
import { applyTheme } from '../../../../apps/web/lib/theme/theme';
import frameCss from '../../../../apps/web/app/chatflow/dsh-upstream/AppFrame.module.css';
import shellCss from '../../../../apps/web/app/chatflow/dsh-saas.module.css';
import { createSidebarFixtureData } from './sidebar-data.mjs';

// The builder loads ALL imported AllRice app/UI/contracts sources from the
// pinned base commit, including the original ChatSidebar and its real readers.
// Only external reads/commands are synthetic; no product component is stubbed.
const data = createSidebarFixtureData();
const params = new URLSearchParams(location.search);
const width = Number(params.get('sidebarWidth') ?? 280);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
applyTheme(theme);
Date.now = () => data.fixedNow;
localStorage.setItem(
  'allrice.employee-tree.v1:org:workspace:person',
  JSON.stringify({ rice: true, writer: true, empty: true }),
);
const reads: string[] = [];
Object.assign(window, { __allriceLegacySidebarReads: reads });
window.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  reads.push(url);
  if (url.includes('/subagents?')) return Response.json({ summary: null });
  return Response.json(
    { error: 'not supplied by baseline fixture' },
    { status: 404 },
  );
};
const noop = () => {};
const archive = {
  sessions: data.sessions,
  filter: 'default',
  loading: false,
  error: '',
  loadError: '',
  legacyOverlayOpen: false,
  setFilter: noop,
  reload: noop,
  hasMore: () => false,
  loadPreview: noop,
  loadMore: noop,
};

function Baseline() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <main
      data-legacy-sidebar-base
      className={`${frameCss.frame} ${shellCss.shell}`}
      style={{ gridTemplateColumns: `${width}px minmax(0, 1fr) 0px` }}
    >
      <ChatSidebar
        workspace={{
          viewerId: 'person',
          organizationId: 'org',
          workspaceId: 'workspace',
          employees: data.employees,
          employeeProfiles: [],
          sessions: data.sessions,
          sessionModels: [],
          canAdminister: false,
        }}
        sessions={data.sessions}
        activeId="thread-0"
        nativeReads={{}}
        archive={archive}
        collapsed={collapsed}
        overlay={innerWidth <= 760 && !collapsed}
        onCollapsedChange={setCollapsed}
        capabilities={() => null}
        monthlyQuota={{ reload: noop }}
        preferences={{ reload: noop }}
        bridge={{ bridgeOpen: false }}
        bridgeReleases={{}}
        settingsSection={null}
        onSettingsSectionChange={noop}
        onBridge={noop}
        onCapabilitiesChange={noop}
        onCreateEmployee={noop}
        onNewSession={noop}
        onOpenEmployeeDetails={noop}
        onSelectSession={noop}
        onEmployeeNavigate={noop}
        onPrepareSession={noop}
        onOpenAutomations={noop}
        onOpenArchive={noop}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Baseline />);
