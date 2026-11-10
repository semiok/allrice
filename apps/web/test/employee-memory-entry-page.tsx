// Real U1 entry/DSH shell; HTTP is intercepted by the browser suite only.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ChatFlowClient } from '../app/chatflow/chatflow-client';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import { ArtifactWorkbench } from '../app/chatflow/artifact-workbench';
import { WorkbenchExperiencePanel } from '../app/chatflow/workbench-experience-panel';
import { setAppearance } from '../lib/theme/appearance';
import { useThemeSync } from '../components/theme/theme-controller';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const query = new URLSearchParams(location.search);
const headers = {};
const scopeId = `${id(3)}/${id(4)}/${id(5)}`;
setAppearance(query.get('theme') === 'dark' ? 'dark' : 'light');

function ProductThemeSync() {
  useThemeSync(location.pathname);
  return null;
}

// Test controls vary only the same public props used by the tenant host.
function DetailsHost() {
  const [target, setTarget] = useState(id(7));
  return (
    <>
      <button id="switch-target" onClick={() => setTarget(id(17))}>
        切换详情员工（测试控件）
      </button>
      <EmployeeDetailsDialog
        open
        scopeId={scopeId}
        instanceId={target}
        workspaceId={id(4)}
        headers={headers}
        organizationView={
          query.has('shared')
            ? { organizationId: id(3), userId: id(5) }
            : undefined
        }
        onClose={() => {}}
        onOpenMemory={() => {}}
      />
    </>
  );
}

function CompactHost() {
  return (
    <ArtifactWorkbench
      desktop={false}
      moduleRequest={{ kind: 'experience', revision: 1 }}
      renderModule={() => <p>不应开放的旧经验模块</p>}
      open
      width={390}
      dockScope="memory-entry-default-compact"
      sessionId={null}
      workspaceId={id(4)}
      tenantHeaders={headers}
      artifacts={[]}
      selectedId={null}
      nextCursor={null}
      listError=""
      listLoading={false}
      narrow
      onSelect={() => {}}
      onClose={() => {}}
      onReload={async () => {}}
    />
  );
}

function LifecycleHost() {
  const [active, setActive] = useState(true);
  const [revision, setRevision] = useState(1);
  return (
    <main>
      <button id="switch-tab" onClick={() => setActive((value) => !value)}>
        切换工作台标签（测试控件）
      </button>
      <button
        id="reopen-target"
        onClick={() => setRevision((value) => value + 1)}
      >
        重开同一目标（测试控件）
      </button>
      <WorkbenchExperiencePanel
        active={active}
        memoryRequest={{ instanceId: id(17), revision }}
        scopeId={scopeId}
        workspaceId={id(4)}
        instanceId={id(7)}
        employees={[{ id: id(7), name: 'Rice' }]}
        headers={headers}
        automatic={false}
        onCorrect={() => {}}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <>
    <ProductThemeSync />
    {query.get('host') === 'details' ? (
      <DetailsHost />
    ) : query.get('host') === 'compact' ? (
      <CompactHost />
    ) : query.get('host') === 'lifecycle' ? (
      <LifecycleHost />
    ) : (
      <ChatFlowClient
        workbenchEnabled={!query.has('disabled')}
        experienceEnabled={query.has('legacy')}
      />
    )}
  </>,
);
