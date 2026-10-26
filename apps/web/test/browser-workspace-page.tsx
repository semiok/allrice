import { createRoot } from 'react-dom/client';
import type { BrowserWorkspaceView } from '@allrice/database';
import { BrowserWorkspacePanel } from '../app/chatflow/browser-workspace-panel';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';

// Shapes follow packages/database/src/browser-control.ts listBrowserWorkspaces:
// a pending approval belongs to the current fence and the acting party, and
// only a workspace whose fence is acknowledged is available.
const RUN = '88888888-8888-4888-8888-888888888888';
const PROFILE = '55555555-5555-4555-8555-555555555555';
const future = new Date(Date.now() + 3_600_000).toISOString();
const now = new Date().toISOString();
function observation(
  id: string,
  fence: number,
  extra: Record<string, unknown> = {},
) {
  return {
    version: 1,
    id,
    profileId: PROFILE,
    fence,
    revision: 1,
    capturedAt: now,
    expiresAt: future,
    url: 'https://example.com/form',
    title: '报名表',
    text: '请填写姓名后提交。',
    pageDigest: `sha256:${'a'.repeat(64)}`,
    elements: [],
    screenshotObjectId: null,
    ...extra,
  };
}
function operation(
  id: string,
  fence: number,
  actor: string,
  observationId: string | null,
  action: Record<string, unknown>,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    snapshot: { status, binding: { attempt: { operationId: id } } },
    command: { fence, actor, observationId, action },
    approval: null,
    result: null,
    available: true,
    ...extra,
  };
}
const approval = (id: string, extra: Record<string, unknown> = {}) => ({
  request: {
    approvalId: id,
    requestId: id.replace(/^c/, 'd'),
    version: 1,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    task: {},
    respondentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    expiresAt: future,
  },
  response: null,
  revokedAt: null,
  ...extra,
});
const profile = {
  origins: [],
  allowUploads: false,
  allowDownloads: true,
  allowHumanCredentials: false,
  maximumFileBytes: 1_000_000,
};
const agentPage = observation('66666666-6666-4666-8666-666666666666', 2, {
  elements: [
    {
      id: 'e1',
      tag: 'button',
      label: '提交订单',
      inputType: '',
      sensitive: false,
    },
    {
      id: 'e2',
      tag: 'input',
      label: '姓名',
      inputType: 'text',
      sensitive: false,
    },
  ],
});
const workspaces = [
  {
    // Closed cloud browser: history, screenshot and page text stay viewable.
    transport: 'cloud',
    localDeviceName: null,
    persistLogin: false,
    preview: null,
    id: '11111111-1111-4111-8111-111111111111',
    runId: RUN,
    profileId: PROFILE,
    state: 'closed',
    fence: 1,
    acknowledgedFence: 1,
    observation: observation('77777777-7777-4777-8777-777777777777', 1, {
      title: '飞书智能伙伴',
      url: 'https://www.feishu.cn/product/ai',
      text: '飞书智能伙伴可以帮你整理会议纪要。',
      screenshotObjectId: '99999999-0000-4000-8000-000000000001',
    }),
    profile,
    available: false,
    operations: [
      operation(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        1,
        'agent',
        null,
        { type: 'navigate', url: 'https://www.feishu.cn/product/ai' },
        'succeeded',
        { result: { status: 200, receipt: { digest: 'x' } }, available: false },
      ),
      operation(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
        1,
        'agent',
        null,
        {
          type: 'request',
          method: 'DELETE',
          url: 'https://www.feishu.cn/account',
        },
        'failed',
        { available: false },
      ),
    ],
  },
  {
    // The employee is using the browser and asks before clicking.
    transport: 'local',
    localDeviceName: '办公室 Mac',
    persistLogin: false,
    preview: null,
    id: '22222222-2222-4222-8222-222222222222',
    runId: RUN,
    profileId: PROFILE,
    state: 'agent',
    fence: 2,
    acknowledgedFence: 2,
    observation: agentPage,
    profile,
    available: true,
    operations: [
      operation(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        2,
        'agent',
        agentPage.id,
        { type: 'click', elementId: 'e1' },
        'waiting_user',
        { approval: approval('cccccccc-cccc-4ccc-8ccc-cccccccccccc') },
      ),
      operation(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
        2,
        'agent',
        agentPage.id,
        { type: 'fill', elementId: 'e2', value: '张三' },
        'waiting_user',
        {
          approval: approval('cccccccc-cccc-4ccc-8ccc-cccccccccccd', {
            response: { decision: 'rejected' },
          }),
        },
      ),
    ],
  },
  {
    // Handed over to the employee: manual controls are live.
    transport: 'local',
    localDeviceName: '办公室 Mac',
    persistLogin: true,
    preview: null,
    id: '33333333-3333-4333-8333-333333333333',
    runId: RUN,
    profileId: PROFILE,
    state: 'human',
    fence: 3,
    acknowledgedFence: 3,
    observation: observation('66666666-6666-4666-8666-666666666667', 3, {
      title: '下载中心',
      elements: [
        {
          id: 'e3',
          tag: 'input',
          label: '搜索',
          inputType: 'text',
          sensitive: false,
        },
        {
          id: 'e4',
          tag: 'a',
          label: '季度报告.pdf',
          inputType: '',
          sensitive: false,
        },
        {
          id: 'e5',
          tag: 'input',
          label: '密码',
          inputType: 'password',
          sensitive: true,
        },
        {
          id: 'e6',
          tag: 'input',
          label: '附件',
          inputType: 'file',
          sensitive: false,
        },
      ],
    }),
    profile: { ...profile, allowUploads: true, allowHumanCredentials: true },
    available: true,
    operations: [
      operation(
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        3,
        'human',
        null,
        { type: 'download', elementId: 'e4' },
        'succeeded',
        {
          result: { downloadObjectId: '99999999-0000-4000-8000-000000000002' },
        },
      ),
    ],
  },
  {
    transport: 'local',
    localDeviceName: '办公室 Mac',
    persistLogin: false,
    preview: {
      processId: 'p',
      endpointId: 'x',
      url: 'https://p-44444444-4444-4444-8444-444444444444.preview.allrice.invalid/',
      port: 5173,
      hardDeadlineAt: future,
    },
    id: '44444444-4444-4444-8444-444444444444',
    runId: RUN,
    profileId: PROFILE,
    state: 'agent',
    fence: 1,
    acknowledgedFence: 1,
    observation: observation('66666666-6666-4666-8666-666666666668', 1, {
      title: '',
      url: 'https://p-44444444-4444-4444-8444-444444444444.preview.allrice.invalid/',
      text: '',
    }),
    profile,
    available: true,
    operations: [
      operation(
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        1,
        'agent',
        null,
        {
          type: 'navigate',
          url: 'https://p-44444444-4444-4444-8444-444444444444.preview.allrice.invalid/',
        },
        'succeeded',
      ),
    ],
  },
] as unknown as BrowserWorkspaceView[];

declare global {
  interface Window {
    approvalPosts: { responseId: string; decision: string }[];
    browserPosts: Record<string, unknown>[];
    filePosts: Record<string, unknown>[];
    signPosts: string[];
    approvalMode: 'ok' | 'network' | 'stale';
    failLoad: boolean;
  }
}
window.approvalPosts = [];
window.browserPosts = [];
window.filePosts = [];
window.signPosts = [];
window.approvalMode = 'ok';
window.failLoad = false;
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('/api/v1/runtime/browser-workspaces')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      window.browserPosts.push(body);
      return Response.json(
        body.kind === 'input'
          ? { inputId: '77777777-7777-4777-8777-777777777777' }
          : {},
      );
    }
    if (window.failLoad) throw new TypeError('Failed to fetch');
    return Response.json({ workspaces });
  }
  if (url === '/api/v1/files') {
    window.filePosts.push(JSON.parse(String(init?.body)));
    return Response.json({
      file: {
        object: {
          id: '77777777-7777-4777-8777-777777777777',
          checksum: `sha256:${'c'.repeat(64)}`,
        },
      },
    });
  }
  if (url.startsWith('/api/v1/runtime/approvals/')) {
    window.approvalPosts.push(JSON.parse(String(init?.body)));
    if (window.approvalMode === 'network') {
      window.approvalMode = 'ok';
      throw new TypeError('Failed to fetch');
    }
    if (window.approvalMode === 'stale') {
      window.approvalMode = 'ok';
      return Response.json(
        { code: 'approval_invalid_or_stale' },
        { status: 403 },
      );
    }
    return Response.json({});
  }
  if (url.startsWith('/api/v1/files/') && url.endsWith('/sign')) {
    const id = url.split('/')[4]!;
    window.signPosts.push(id);
    return Response.json({ url: `/api/v1/files/${id}?signature=x` });
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
      employeeName="Rice"
    />
  </main>,
);
