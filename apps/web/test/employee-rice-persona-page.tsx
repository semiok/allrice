// Real tenant entry and product typography; HTTP is intercepted by the suite.
import { createRoot } from 'react-dom/client';
import { ChatFlowClient } from '../app/chatflow/chatflow-client';
import { setAppearance } from '../lib/theme/appearance';
import { useThemeSync } from '../components/theme/theme-controller';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';

setAppearance(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
function Page() {
  useThemeSync(location.pathname);
  return <ChatFlowClient workbenchEnabled />;
}
createRoot(document.getElementById('root')!).render(<Page />);
