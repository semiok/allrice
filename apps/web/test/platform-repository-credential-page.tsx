import { createRoot } from 'react-dom/client';
import { PlatformRepositoryCredentialPanel } from '../app/runtime-console/platform-repository-credential';
createRoot(document.getElementById('root')!).render(
  <PlatformRepositoryCredentialPanel />,
);
