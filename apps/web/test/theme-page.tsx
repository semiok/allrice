import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useThemeSync } from '../components/theme/theme-controller';
import { DshDialog } from '../app/chatflow/dsh-upstream/Dialog';
import { setTenantTheme } from '../lib/theme/theme';

function Fixture() {
  const [pathname, setPathname] = useState(location.pathname);
  // Only the dialog checks open it: its backdrop covers the page.
  const [dialog, setDialog] = useState(location.search.includes('dialog'));
  const [saved, setSaved] = useState<boolean | null>(null);
  useThemeSync(pathname);
  const go = (path: string) => {
    history.pushState(null, '', path);
    setPathname(path);
  };
  return (
    <main>
      <p id="surface">{pathname}</p>
      <p id="saved">{saved === null ? '' : String(saved)}</p>
      <button type="button" onClick={() => go('/runtime-console')}>
        去后台
      </button>
      <button type="button" onClick={() => go('/chatflow')}>
        去前台
      </button>
      {/* What the switch in 设置 → 个人偏好 will call. */}
      <button type="button" onClick={() => setSaved(setTenantTheme('dark'))}>
        选深色
      </button>
      <button type="button" onClick={() => setSaved(setTenantTheme('light'))}>
        选浅色
      </button>
      {/* A DSH dialog portals to <body>, outside any page theme wrapper. */}
      {dialog ? (
        <DshDialog
          ariaLabel="员工详情"
          title="员工详情"
          onClose={() => setDialog(false)}
        >
          <p id="dialog-text">负责整理每周的销售数据。</p>
        </DshDialog>
      ) : null}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
