import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { PersonalSceneReadPanel } from '../app/chatflow/personal-scene-reads';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import { employeeDetailsFixture } from './employee-details-fixture';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../../../packages/ui/src/tokens.css';
document.body.style.background = 'var(--ar-surface)';
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function Page() {
  const [other, setOther] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const dialog = new URLSearchParams(location.search).has('dialog');
  return (
    <main
      style={{
        maxWidth: 1080,
        margin: '20px auto',
        padding: 16,
        font: 'var(--ar-font-body)',
        color: 'var(--ar-text)',
      }}
    >
      <button type="button" onClick={() => setOther((value) => !value)}>
        切换另一员工
      </button>
      <h2>本人 Workflow 读取核对</h2>
      {dialog ? (
        <EmployeeDetailsDialog
          open={detailsOpen}
          scopeId={other ? 'viewer-B' : 'viewer-A'}
          instanceId={id(other ? 2 : 1)}
          employeeId={employeeDetailsFixture().content.employeeId}
          workspaceId={id(10)}
          headers={{}}
          onClose={() => setDetailsOpen(false)}
        />
      ) : (
        <PersonalSceneReadPanel
          scopeId={other ? 'viewer-B' : 'viewer-A'}
          instanceId={id(other ? 2 : 1)}
          workspaceId={id(10)}
          headers={{}}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
