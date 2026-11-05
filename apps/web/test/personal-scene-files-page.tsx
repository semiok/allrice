import { createRoot } from 'react-dom/client';
import { useRef, useState } from 'react';
import {
  PersonalSceneFilePanel,
  type PersonalSceneFileWriteStore,
} from '../app/chatflow/personal-scene-files';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import { employeeDetailsFixture } from './employee-details-fixture';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../../../packages/ui/src/tokens.css';

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function Page() {
  const [other, setOther] = useState(false);
  const [otherViewer, setOtherViewer] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const writes = useRef<PersonalSceneFileWriteStore>(new Map());
  const dialog = new URLSearchParams(location.search).has('dialog');
  const scopeId = otherViewer
    ? 'viewer-other'
    : other
      ? 'viewer-B'
      : 'viewer-A';
  return (
    <main
      style={{
        maxWidth: 1080,
        margin: '20px auto',
        padding: 16,
        color: 'var(--ar-text)',
        font: 'var(--ar-font-body)',
      }}
    >
      <button type="button" onClick={() => setOther((value) => !value)}>
        切换另一员工
      </button>
      <button type="button" onClick={() => setOtherViewer((value) => !value)}>
        切换查看者
      </button>
      <h2>我的周报助理</h2>
      {dialog ? (
        <>
          <button type="button" onClick={() => setDetailsOpen(true)}>
            打开员工详情
          </button>
          <EmployeeDetailsDialog
            open={detailsOpen}
            scopeId={scopeId}
            instanceId={id(other ? 2 : 1)}
            employeeId={employeeDetailsFixture().content.employeeId}
            workspaceId={id(10)}
            headers={{}}
            onClose={() => setDetailsOpen(false)}
          />
        </>
      ) : (
        <PersonalSceneFilePanel
          scopeId={scopeId}
          instanceId={id(other ? 2 : 1)}
          workspaceId={id(10)}
          headers={{}}
          writes={writes.current}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
