// Isolated management UI used only by the loopback PostgreSQL/browser fixture.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TenantAdministration } from '../app/runtime-console/tenant-administration';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TenantAdministration />
  </StrictMode>,
);
