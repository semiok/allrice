import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { EmployeeDetailsDialog } from '../app/chatflow/employee-details-dialog';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../../../packages/ui/src/tokens.css';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const headers = {};
const sharedViewer = { organizationId: id(3), userId: id(5) };
const query = new URLSearchParams(location.search);
if (query.get('theme') === 'dark')
  document.body.setAttribute('data-ds-dark-theme', '');
document.body.style.background = 'var(--ar-surface)';

function Page() {
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(false);
  return (
    <main style={{ padding: 24, color: 'var(--ar-text)' }}>
      <p>合成 HTTP 人设测试，不连接真实账号。</p>
      <button type="button" onClick={() => setOpen(true)}>
        打开员工详情
      </button>
      <button type="button" onClick={() => setOther((value) => !value)}>
        切换另一员工
      </button>
      <EmployeeDetailsDialog
        open={open}
        scopeId="persona-card-fixture-viewer"
        instanceId={id(other ? 17 : 7)}
        workspaceId={id(4)}
        headers={headers}
        organizationView={query.has('shared') ? sharedViewer : undefined}
        onClose={() => setOpen(false)}
      />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
