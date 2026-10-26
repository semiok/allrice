// Isolated Chromium page: real panels, synthetic HTTP. No DB, device or model.
import { createRoot } from 'react-dom/client';
import type { WorkbenchArtifact } from '@allrice/contracts';
import { CloudOperationPanel } from '../app/chatflow/cloud-operation-panel';
import { ChangesetPanel } from '../app/chatflow/changeset-panel';
import {
  InteractionStatusPanel,
  useInteractionStatus,
} from '../app/chatflow/interaction-status';
import {
  changesetRuns,
  cloudOperations,
  ids,
  pendingActions,
} from './technical-details-fixtures';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';

declare global {
  interface Window {
    detailsApprovals: { url: string; body: Record<string, unknown> }[];
    detailsStatusReads: number;
    detailsOpened: string[];
  }
}
window.detailsApprovals = [];
window.detailsStatusReads = 0;
window.detailsOpened = [];
const OFFLINE_SESSION = '20000000-0000-4000-8000-000000000001';
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('/api/v1/runtime/cloud-operations'))
    return Response.json({
      operations: cloudOperations(
        window.detailsApprovals.some((post) =>
          post.url.endsWith(ids.mcpApproval),
        ),
      ),
    });
  if (url.startsWith('/api/v1/runtime/approvals/')) {
    window.detailsApprovals.push({ url, body: JSON.parse(String(init?.body)) });
    return Response.json({});
  }
  const artifact = url.match(/\/artifacts\/([^/]+)\/executions/)?.[1];
  if (artifact) return Response.json({ executions: changesetRuns(artifact) });
  if (url.startsWith(`/api/v1/sessions/${OFFLINE_SESSION}/`)) {
    window.detailsStatusReads += 1;
    return Response.json({}, { status: 503 });
  }
  if (url.startsWith(`/api/v1/sessions/${ids.session}/interactions`))
    return Response.json({ runtime: null, inputs: [], pendingActions });
  return realFetch(input, init);
};

const artifact = (id: string) =>
  ({
    id,
    object: { checksum: `sha256:${'9'.repeat(64)}` },
  }) as WorkbenchArtifact;
const headers = {};
function Status({ sessionId }: { sessionId: string }) {
  const status = useInteractionStatus(true, sessionId, ids.workspace, headers);
  return (
    <InteractionStatusPanel
      data={status.data}
      error={status.error}
      sessionId={sessionId}
      onArtifact={(id) => window.detailsOpened.push(`artifact:${id}`)}
      onOperation={(id) => window.detailsOpened.push(`operation:${id}`)}
      onRetry={() => void status.reload()}
    />
  );
}

if (new URLSearchParams(location.search).get('theme') === 'dark')
  document.body.setAttribute('data-ds-dark-theme', '');
createRoot(document.getElementById('root')!).render(
  <main
    style={{
      display: 'grid',
      gap: 16,
      maxWidth: 760,
      margin: '0 auto',
      padding: 16,
      minHeight: '100vh',
      background: 'var(--dsw-alias-bg-base)',
      color: 'var(--dsw-alias-label-primary)',
    }}
  >
    <section data-case="status">
      <Status sessionId={ids.session} />
    </section>
    <section data-case="status-offline">
      <Status sessionId={OFFLINE_SESSION} />
    </section>
    <section data-case="cloud">
      <CloudOperationPanel
        runId={ids.run}
        workspaceId={ids.workspace}
        tenantHeaders={headers}
        runActive={false}
      />
    </section>
    <section data-case="changeset">
      <ChangesetPanel
        artifact={artifact(ids.artifact)}
        sessionId={ids.session}
        workspaceId={ids.workspace}
        headers={headers}
        disabled={false}
      />
    </section>
    <section data-case="changeset-done">
      <ChangesetPanel
        artifact={artifact(ids.doneArtifact)}
        sessionId={ids.session}
        workspaceId={ids.workspace}
        headers={headers}
        disabled={false}
      />
    </section>
  </main>,
);
