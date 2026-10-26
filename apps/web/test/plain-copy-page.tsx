import type { CSSProperties, ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AutomationCatalogTask,
  UserMonthlyQuota,
  WorkspaceCapability,
  WorkspaceReadiness,
} from '@allrice/contracts';
import { workspaceCapabilityIds } from '@allrice/contracts';
import { MonthlyQuota } from '../app/chatflow/monthly-quota';
import { AccountPasswordSettings } from '../app/chatflow/account-password-settings';
import { BridgeSettings } from '../app/chatflow/bridge-dialog';
import { CapabilityContent } from '../app/chatflow/capability-panel';
import { AutomationTaskList } from '../app/chatflow/automation-tasks';
import type { useBridge } from '../app/chatflow/use-bridge';
import type { useBridgeReleases } from '../app/chatflow/bridge-releases';
import type { BridgeDevice } from '../app/chatflow/chatflow-types';
import '../app/dsh-upstream/design-platform.css';
import '../app/dsh-upstream/base.css';
import '../app/styles/base.css';

/** Static props and a synthetic fetch only: no server, database, device or model. */
const noop = () => {};
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = '2026-10-26T01:00:00.000Z';
const quota: UserMonthlyQuota = {
  organizationId: id(1),
  workspaceId: id(2),
  userId: id(3),
  displayName: '王小明',
  monthlyTokenLimit: 5_000_000,
  usedTokens: 2_824_029,
  remainingTokens: 2_175_971,
  remainingPercent: 43.5,
  unknownUsageRuns: 2,
  periodStart: '2026-10-01T00:00:00Z',
  resetsAt: '2026-11-01T12:00:00Z',
  observedAt: now,
};

const device = (status: BridgeDevice['status'], n: number): BridgeDevice => ({
  id: id(n),
  name: n === 10 ? 'Rice Bridge' : 'MacBook-Pro.local · Rice Bridge',
  platform: 'macos-arm64',
  status,
  lastSeenAt: now,
  clientVersion: '0.6.0',
  folderGrants: [{ id: id(n + 1), label: '销售周报' }],
  preparation: [
    {
      component: 'python',
      stage: 'failed',
      reason: 'RUNTIME_DOWNLOAD_STALLED',
      receivedBytes: 1024 ** 2,
      expectedBytes: 40 * 1024 ** 2,
      attempt: 2,
      resumed: false,
      updatedAt: now,
    },
  ],
  readiness: (
    [
      ['local.fs.read', 'ready', 'ready'],
      ['local.git.status', 'unsupported', 'git_missing'],
      ['local.browser', 'unsupported', 'synthetic_unlisted_reason'],
      ['local.process', 'unsupported', 'legacy_unreported'],
      ['local.office', 'unsupported', 'office_not_implemented'],
    ] as const
  ).map(([capability, state, reason]) => ({
    capability,
    state,
    reason,
    missing: [],
    versions: { bridge: '0.6.0', node: '22.23.2' },
    observedAt: now,
  })),
});
const bridge = {
  bridgeDevices: [device('online', 10), device('offline', 20)],
  bridgeStatusKnown: true,
  bridgeBusy: false,
  bridgeRefreshError: '',
  bridgeLastRefreshedAt: now,
  bridgeRecoveryActive: false,
  bridgePairingBusy: false,
  bridgePairing: { code: 'ABCD-1234', expiresAt: now },
  bridgeFeedback: { kind: 'info', message: '配对码已生成，10 分钟内有效。' },
  loadBridgeDevices: noop,
  requestBridgeWorkspaceSelection: noop,
  disconnectBridgeWorkspace: noop,
  createBridgePairing: noop,
  copyBridgePairingCode: noop,
  noteBridgeDownload: noop,
} as unknown as ReturnType<typeof useBridge>;
const releases = {
  releases: [
    { platform: 'macos-arm64', available: true, version: '0.6.1' },
    { platform: 'macos-x64', available: false, version: null },
  ],
  error: false,
  reload: async () => {},
} as unknown as ReturnType<typeof useBridgeReleases>;

const states: Partial<
  Record<
    WorkspaceCapability['id'],
    Pick<WorkspaceCapability, 'state' | 'reason' | 'action'>
  >
> = {
  report: { state: 'ready', reason: 'ready', action: 'compose' },
  assistants: {
    state: 'unsupported',
    reason: 'provider_unsupported',
    action: 'guide',
  },
  boost: { state: 'not_released', reason: 'release_disabled', action: 'guide' },
  teamwork: { state: 'not_released', reason: 'planned', action: 'guide' },
  local_command: {
    state: 'unsupported',
    reason: 'runner_missing',
    action: 'bridge',
  },
  development: {
    state: 'unsupported',
    reason: 'candidate_runner_missing',
    action: 'bridge',
  },
  local_browser: {
    state: 'device_offline',
    reason: 'bridge_offline',
    action: 'bridge',
  },
};
const readiness: WorkspaceReadiness = {
  schemaVersion: 1,
  organizationId: id(1),
  workspaceId: id(2),
  viewerId: id(3),
  sessionId: null,
  employeeVersionId: null,
  canAdminister: false,
  observedAt: now,
  basis: 'next_task',
  capabilities: workspaceCapabilityIds.map((capability) => ({
    id: capability,
    state: 'ready',
    reason: 'ready',
    action: 'compose',
    ...states[capability],
    target: 'cloud',
    responsibleRole: 'user',
    releaseEnabled: true,
    authorization: 'normal_policy',
  })),
};

const task = (
  n: number,
  rule: object,
  status = 'enabled',
): AutomationCatalogTask =>
  ({
    id: id(n),
    name: `每日工作提醒 ${n}`,
    prompt: '提醒我写日报',
    employeeId: id(4),
    employeeName: 'Rice',
    sessionId: id(5),
    sessionTitle: '日报',
    sourceArchived: n === 41,
    createdAt: now,
    nextRunAt: '2026-11-01T01:00:00.000Z',
    canStop: true,
    revision: 1,
    definition: {
      kind: 'recurring',
      task: {
        id: id(n),
        name: `每日工作提醒 ${n}`,
        prompt: '提醒我写日报',
        sessionId: id(5),
        clientRequestId: id(n + 100),
        rule,
        revision: 1,
        status,
        nextRunAt: '2026-11-01T01:00:00.000Z',
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        canManage: true,
        latestOccurrence: null,
      },
    },
  }) as AutomationCatalogTask;
// Workspace IDs select what the synthetic catalog returns.
const catalogs: Record<string, () => Response> = {
  [id(31)]: () => Response.json({ tasks: [], nextCursor: null }),
  [id(32)]: () =>
    Response.json({
      tasks: [
        task(40, {
          kind: 'daily',
          time: '09:00:00',
          timezone: 'Asia/Shanghai',
        }),
        task(
          41,
          {
            kind: 'weekly',
            weekdays: [1, 3],
            time: '18:30:00',
            timezone: 'Asia/Shanghai',
          },
          'paused',
        ),
      ],
      nextCursor: null,
    }),
  [id(33)]: () =>
    new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    }),
  [id(34)]: () => Response.json({ tasks: [{ unexpected: true }] }),
  // A conversation whose only task is paused.
  [id(35)]: () =>
    Response.json({
      tasks: [
        task(
          42,
          { kind: 'daily', time: '09:00:00', timezone: 'Asia/Shanghai' },
          'paused',
        ),
      ],
      nextCursor: null,
    }),
};
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href);
  const catalog = catalogs[url.searchParams.get('workspaceId') ?? ''];
  // The password may have changed before the reply was lost.
  if (url.pathname === '/api/v1/auth/password')
    throw new TypeError('Failed to fetch');
  return url.pathname === '/api/v1/scheduled-tasks' && catalog
    ? catalog()
    : realFetch(input, init);
};

const automation = (workspaceId: string, sessionId?: string) => (
  <AutomationTaskList
    workspaceId={workspaceId}
    sessionId={sessionId}
    scope="synthetic"
    headers={{}}
    employees={[{ id: id(4), name: 'Rice' }]}
    onSelect={noop}
    onNew={noop}
  />
);
const cases: [string, ReactNode][] = [
  [
    'account',
    <>
      <MonthlyQuota data={quota} failed={false} onRefresh={noop} />
      <MonthlyQuota
        data={{
          ...quota,
          codexTokenPolicy: 'observe',
          cachedInputTokens: null,
        }}
        failed={false}
        onRefresh={noop}
      />
      <MonthlyQuota data={null} failed onRefresh={noop} />
      <AccountPasswordSettings />
    </>,
  ],
  ['computer', <BridgeSettings bridge={bridge} releases={releases} />],
  [
    'work',
    <>
      {(['work', 'computer'] as const).map((scope) => (
        <CapabilityContent
          key={scope}
          scope={scope}
          data={readiness}
          loading={false}
          error=""
          busy={false}
          onRefresh={noop}
          onBridge={noop}
          onCompose={noop}
        />
      ))}
    </>,
  ],
  ['automation-empty', automation(id(31))],
  ['automation-tasks', automation(id(32))],
  ['automation-unreadable', automation(id(33))],
  ['automation-invalid', automation(id(34))],
  ['automation-conversation', automation(id(35), id(5))],
];

if (new URLSearchParams(location.search).get('theme') === 'dark')
  document.body.setAttribute('data-ds-dark-theme', '');
createRoot(document.getElementById('root')!).render(
  <main
    style={
      {
        display: 'grid',
        gap: 24,
        padding: 16,
        minHeight: '100vh',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
        // The settings dialog defines this alias for its contents.
        '--dsw-alias-border-primary': 'var(--dsw-alias-border-l2)',
      } as CSSProperties
    }
  >
    {cases.map(([name, content]) => (
      <section
        key={name}
        data-case={name}
        style={{ minWidth: 0, display: 'grid', gap: 16 }}
      >
        {content}
      </section>
    ))}
  </main>,
);
