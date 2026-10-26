import { createRoot } from 'react-dom/client';
import type { BrowserWorkspaceView } from '@allrice/database';
import { BrowserWorkspacePanel } from '../app/chatflow/browser-workspace-panel';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';

const RUN = '88888888-8888-4888-8888-888888888888';
const future = new Date(Date.now() + 3_600_000).toISOString();
const observation = {
  version: 1,
  id: '66666666-6666-4666-8666-666666666666',
  profileId: '55555555-5555-4555-8555-555555555555',
  fence: 2,
  revision: 1,
  capturedAt: new Date().toISOString(),
  expiresAt: future,
  url: 'https://example.com/form',
  title: '报名表',
  text: '请填写姓名后提交。',
  pageDigest: `sha256:${'a'.repeat(64)}`,
  elements: [
    {
      id: 'e1',
      tag: 'input',
      label: '姓名',
      inputType: 'text',
      sensitive: false,
    },
    { id: 'e2', tag: 'button', label: '', inputType: '', sensitive: false },
  ],
  screenshotObjectId: null,
};
function operation(
  id: string,
  action: Record<string, unknown>,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    snapshot: { status, binding: { attempt: { operationId: id } } },
    command: { fence: 2, actor: 'agent', observationId: null, action },
    approval: null,
    result: null,
    available: true,
    ...extra,
  };
}
const workspaces = [
  {
    transport: 'cloud',
    localDeviceName: null,
    persistLogin: false,
    preview: null,
    id: '11111111-1111-4111-8111-111111111111',
    runId: RUN,
    profileId: observation.profileId,
    state: 'closed',
    fence: 1,
    acknowledgedFence: 1,
    observation: null,
    profile: { origins: [], allowUploads: false, allowDownloads: false },
    available: false,
    operations: [
      operation(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        { type: 'navigate', url: 'https://example.com/news' },
        'succeeded',
        { result: { status: 200, receipt: { digest: 'x' } }, available: false },
      ),
    ],
  },
  {
    transport: 'local',
    localDeviceName: '办公室 Mac',
    persistLogin: false,
    preview: null,
    id: '22222222-2222-4222-8222-222222222222',
    runId: RUN,
    profileId: observation.profileId,
    state: 'human',
    fence: 2,
    acknowledgedFence: 2,
    observation,
    profile: {
      origins: ['https://example.com'],
      allowUploads: false,
      allowDownloads: false,
      allowHumanCredentials: false,
      maximumFileBytes: 1_000_000,
    },
    available: true,
    operations: [
      operation(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        { type: 'click', elementId: 'e2' },
        'waiting_user',
        {
          command: {
            fence: 1,
            actor: 'agent',
            observationId: null,
            action: { type: 'click', elementId: 'e2' },
          },
          approval: {
            request: {
              approvalId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              requestId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              version: 1,
              requestDigest: `sha256:${'b'.repeat(64)}`,
              task: {},
              respondentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              expiresAt: future,
            },
            response: null,
            revokedAt: null,
          },
        },
      ),
    ],
  },
] as unknown as BrowserWorkspaceView[];

declare global {
  interface Window {
    approvalPosts: unknown[];
    failNextApproval: boolean;
  }
}
window.approvalPosts = [];
window.failNextApproval = false;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('/api/v1/runtime/browser-workspaces'))
    return Response.json({ workspaces });
  if (url.startsWith('/api/v1/runtime/approvals/')) {
    window.approvalPosts.push(JSON.parse(String(init?.body)));
    if (window.failNextApproval) {
      window.failNextApproval = false;
      return new Response(null, { status: 503 });
    }
    return Response.json({});
  }
  return realFetch(input, init);
};

if (new URLSearchParams(location.search).get('theme') === 'dark')
  document.body.setAttribute('data-ds-dark-theme', '');
createRoot(document.getElementById('root')!).render(
  <main style={{ padding: 16 }}>
    <BrowserWorkspacePanel
      runId={RUN}
      workspaceId="99999999-9999-4999-8999-999999999999"
      tenantHeaders={{}}
      runActive={false}
    />
  </main>,
);
