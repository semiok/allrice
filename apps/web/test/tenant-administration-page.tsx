// Isolated management UI used only by the loopback PostgreSQL/browser fixture.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { TenantAdministration } from '../app/runtime-console/tenant-administration';
import { EmployeeProduction } from '../app/runtime-console/employee-production';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {new URLSearchParams(window.location.search).get('view') === 'employees' ? (
      <EmployeeProduction />
    ) : (
      <TenantAdministration />
    )}
  </StrictMode>,
);
