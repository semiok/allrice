import { createRoot } from 'react-dom/client';
import { PlatformMaintenanceGithubBot } from '../app/runtime-console/platform-maintenance-github-bot';
createRoot(document.getElementById('root')!).render(
  <PlatformMaintenanceGithubBot />,
);
