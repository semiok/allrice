// Isolated full tenant UI; no production auth bypass or model invocation.
import { createRoot } from 'react-dom/client';
import { TenantFeedback } from '../app/runtime-console/tenant-feedback';
import { ChatFlowClient } from '../app/chatflow/chatflow-client';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/dsh-upstream/scrollbar.css';
import '../app/styles/base.css';
import '@allrice/ui/styles.css';
createRoot(document.getElementById('root')!).render(
  location.search.includes('feedback-inbox') ? (
    <TenantFeedback />
  ) : (
    <ChatFlowClient workbenchEnabled={!location.search.includes('disabled')} />
  ),
);
