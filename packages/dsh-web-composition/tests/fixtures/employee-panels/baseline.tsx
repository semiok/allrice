import { createRoot } from 'react-dom/client';
import { EnterpriseMaterialsPanel } from '../../../../../apps/web/app/chatflow/enterprise-materials-panel';
import { WorkbenchFilesPanel } from '../../../../../apps/web/app/chatflow/workbench-files-panel';
import { EmployeeMemorySidebar } from '../../../../../apps/web/app/chatflow/employee-memory-sidebar';
import { EmployeeCapabilitiesPanel } from '../../../../../apps/web/app/chatflow/employee-capabilities-panel';
import { applyTheme } from '../../../../../apps/web/lib/theme/theme';
import { syntheticPanelSnapshot } from './presentation';
import { panelStates } from './data';

// Same approved rev2 real component mount and original global styles. This
// fixture is a visual replay; it neither implements a replacement panel nor
// claims its inert controller callbacks performed a business operation.
const query = new URLSearchParams(location.search);
const requested = query.get('state');
const state = panelStates.find((value) => value === requested) ?? 'list';
const theme = query.get('theme') === 'dark' ? 'dark' : 'light';
applyTheme(theme);
const width = Number(query.get('paneWidth') ?? 420);
const height = Number(query.get('paneHeight') ?? 800);
const scope = syntheticPanelSnapshot(
  'synthetic/rev2-visual-replay',
  state,
  () => {},
);
const actions = {
  signal: new AbortController().signal,
  openMain: async () => {},
};
const content = () => {
  switch (query.get('kind')) {
    case 'materials':
      return (
        <EnterpriseMaterialsPanel
          {...scope.materials}
          active
          onUse={() => {}}
        />
      );
    case 'files':
      return <WorkbenchFilesPanel {...scope.files} active onUse={() => {}} />;
    case 'experience':
      return <EmployeeMemorySidebar {...scope.experience} active />;
    case 'workflow':
      return <EmployeeCapabilitiesPanel {...scope.workflow(actions)} active />;
    default:
      throw Error('Unknown rev2 replay kind');
  }
};
createRoot(document.getElementById('root')!).render(
  <div data-panels-rev2-replay className="m0-before" style={{ width, height }}>
    {content()}
  </div>,
);
