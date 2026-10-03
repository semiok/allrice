import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminShell } from '../components/admin/admin-shell';
import {
  AdminButton,
  AdminDialog,
  AdminMenu,
} from '../components/admin/admin-ui';

function DesignFixture() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState('组织管理');
  return (
    <>
      <p data-outside>员工前台</p>
      <AdminShell
        items={(['组织管理', 'AI 员工', '公司看板', '平台设置'] as const).map(
          (label) => ({
            label,
            icon: 'organization',
            active: view === label,
            onSelect: () => setView(label),
          }),
        )}
      >
        <section style={{ padding: 24 }}>
          <h1>{view}</h1>
          <AdminButton variant="primary" onClick={() => setOpen(true)}>
            添加员工
          </AdminButton>
          <AdminMenu label="员工操作">
            <AdminButton>编辑员工</AdminButton>
          </AdminMenu>
          {open && (
            <AdminDialog
              title="添加员工"
              busy={busy}
              onClose={() => setOpen(false)}
            >
              <form onSubmit={(event) => event.preventDefault()}>
                <label>
                  姓名
                  <input name="name" />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={busy}
                    onChange={(event) => setBusy(event.target.checked)}
                  />
                  提交中
                </label>
                <AdminButton type="submit">保存员工</AdminButton>
              </form>
            </AdminDialog>
          )}
        </section>
      </AdminShell>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<DesignFixture />);
