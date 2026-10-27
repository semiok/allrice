// Isolated full tenant UI; no production auth bypass or model invocation.
import { createRoot } from 'react-dom/client';
import { TenantFeedback } from '../app/runtime-console/tenant-feedback';
import { ChatFlowClient } from '../app/chatflow/chatflow-client';
import { useThemeSync } from '../components/theme/theme-controller';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
// The root layout loads the design tokens here; the chat shell reads them.
import '@allrice/ui/tokens.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';
// The root layout's ThemeController, only where a test serves the theme
// scripts: other tests set the theme attributes themselves.
function ThemeSync() {
  useThemeSync(location.pathname);
  return null;
}
createRoot(document.getElementById('root')!).render(
  location.search.includes('feedback-inbox') ? (
    <TenantFeedback />
  ) : (
    <>
      {location.search.includes('theme=1') ? <ThemeSync /> : null}
      <ChatFlowClient
        workbenchEnabled={!location.search.includes('disabled')}
        taskSuggestionsEnabled={location.search.includes('task-suggestions')}
        localMcpEnabled={location.search.includes('local-mcp')}
      />
    </>
  ),
);
