import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MaintenanceReportActions } from '../app/runtime-console/platform-maintenance-report-actions';
import {
  MaintenanceReportAuthoritySchema,
  type MaintenanceDeployment,
} from '@allrice/database/technical-contracts';
function Page() {
  const input = (
    window as unknown as {
      maintenanceFixture: {
        reportId: string;
        reportDigest: string;
        authority: Parameters<typeof MaintenanceReportActions>[0]['authority'];
        deployment: MaintenanceDeployment;
      };
    }
  ).maintenanceFixture;
  const [authority, setAuthority] = useState(input.authority);
  async function refresh() {
    const r = await fetch('/authority');
    if (!r.ok) return null;
    const value = MaintenanceReportAuthoritySchema.parse(await r.json());
    setAuthority(value);
    return value;
  }
  return (
    <MaintenanceReportActions
      reportId={input.reportId}
      reportDigest={input.reportDigest}
      authority={authority}
      deployment={input.deployment}
      ready
      refresh={refresh}
    />
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
