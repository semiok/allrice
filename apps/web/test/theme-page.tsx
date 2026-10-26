import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useThemeSync } from '../components/theme/theme-controller';

function Fixture() {
  const [pathname, setPathname] = useState(location.pathname);
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
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
