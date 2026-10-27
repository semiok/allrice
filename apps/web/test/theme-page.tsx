import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useThemeSync } from '../components/theme/theme-controller';
import { DshDialog } from '../app/chatflow/dsh-upstream/Dialog';

function Fixture() {
  const [pathname, setPathname] = useState(location.pathname);
  // Only the dialog checks open it: its backdrop covers the page.
  const [dialog, setDialog] = useState(location.search.includes('dialog'));
  useThemeSync(pathname);
  const go = (path: string) => {
    history.pushState(null, '', path);
    setPathname(path);
  };
  return (
    <main>
      <p id="surface">{pathname}</p>
      <button type="button" onClick={() => go('/runtime-console')}>
        去后台
      </button>
      <button type="button" onClick={() => go('/chatflow')}>
        去前台
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
