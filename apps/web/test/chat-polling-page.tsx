// Real hooks and UI with synthetic HTTP only; never a product route.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  InteractionStatusPanel,
  useInteractionStatus,
} from '../app/chatflow/interaction-status';
import { useBridge } from '../app/chatflow/use-bridge';
import { useMonthlyQuota } from '../app/chatflow/use-monthly-quota';
import type { Workspace } from '../app/chatflow/chatflow-types';

const headers = {
  'x-allrice-organization-id': 'org',
  'x-allrice-workspace-id': 'workspace',
};
const workspace: Workspace = {
  organizationId: 'org',
  workspaceId: 'workspace',
  viewerId: 'viewer',
  employees: [],
  employeeProfiles: [],
  sessions: [],
  sessionModels: [],
  canAdminister: false,
};
function Page() {
  const [session, setSession] = useState('session-a');
  const [, setError] = useState('');
  const status = useInteractionStatus(
    !location.search.includes('timings'),
    session,
    workspace.workspaceId,
    headers,
  );
  const originalReload = useRef(status.reload);
  const bridge = useBridge({ workspace, tenantHeaders: headers, setError });
  useMonthlyQuota({ ...workspace, headers, refreshKey: session });
  return (
    <>
      <button onClick={() => setSession('session-b')}>切换工作</button>
      <button onClick={() => void status.reload()}>刷新状态</button>
      <button onClick={() => void originalReload.current()}>完成旧操作</button>
      <button onClick={() => bridge.noteBridgeDownload('macOS')}>
        已下载电脑助手
      </button>
      <output data-testid="snapshot">
        {status.data?.runtime?.configChecksum ??
          (status.data ? 'timings-ready' : '')}
      </output>
      <InteractionStatusPanel
        sessionId={session}
        data={status.data}
        error={status.error}
        onArtifact={() => {}}
        onRetry={() => void status.reload()}
      />
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Page />);
