import { createRoot } from 'react-dom/client';
import { PlatformMcpSettingsPanel } from '../app/runtime-console/platform-mcp-settings';
import admin from '../components/admin/admin-ui.module.css';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';

createRoot(document.getElementById('root')!).render(
  <main data-admin-theme="dark" className={admin.theme}>
    <PlatformMcpSettingsPanel />
  </main>,
);
