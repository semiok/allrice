// The actual tenant host. Only HTTP is replaced by the browser test server.
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

const query = new URLSearchParams(location.search);
setAppearance(query.get('theme') === 'dark' ? 'dark' : 'light');

function ProductThemeSync() {
  useThemeSync(location.pathname);
  return null;
}

createRoot(document.getElementById('root')!).render(
  <>
    <ProductThemeSync />
    <ChatFlowClient workbenchEnabled={!query.has('disabled')} />
  </>,
);
