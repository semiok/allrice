import {
  workspaceCapabilityIds,
  developmentWorkflowToolNames,
  resolveEmployeeToolDependencies,
  type WorkspaceCapability,
  type WorkspaceCapabilityId,
  type RuntimePolicyControls,
} from '@allrice/contracts';

export interface ReadinessFacts {
  canAdminister: boolean;
  canExecute: boolean;
  employee: boolean;
  tools: string[];
  capabilities: string[];
  deniedCapabilities: string[];
  provider: string;
  controls: RuntimePolicyControls | null;
  governedLocalReads: boolean;
  bridge: 'missing' | 'offline' | 'online';
  preparation?: {
    browser?: string;
    sandbox?: string;
    development?: string;
    paused?: boolean;
  };
  folder: boolean;
  runner: boolean;
  developmentRunner: boolean;
  cloud: 'missing' | 'unavailable' | 'ungranted' | 'invalid' | 'ready';
  cloudBrowser: 'missing' | 'unavailable' | 'ungranted' | 'invalid' | 'ready';
  localBrowser: 'missing' | 'unavailable' | 'ungranted' | 'invalid' | 'ready';
  cloudMcp: 'missing' | 'unverified' | 'ungranted' | 'ready';
  localMcp: 'missing' | 'unverified' | 'ungranted' | 'ready';
  cloudMcpPolicy: boolean;
  localMcpPolicy: boolean;
  flags: Record<WorkspaceCapabilityId, boolean>;
}
const definitions: Record<
  WorkspaceCapabilityId,
  {
    target: WorkspaceCapability['target'];
    tools: string[];
    capabilities: string[];
    actions?: string[];
    authorization: WorkspaceCapability['authorization'];
  }
> = {
  report: {
    target: 'cloud',
    tools: ['workspace.export.create'],
    capabilities: ['storage:write'],
    authorization: 'normal_policy',
  },
  local_files: {
    target: 'local',
    tools: ['local.fs.list', 'local.fs.read'],
    capabilities: ['storage:read'],
    authorization: 'normal_policy',
  },
  changeset: {
    target: 'local',
    tools: ['local.fs.write'],
    capabilities: ['storage:write'],
    actions: ['local.fs.changeset'],
    authorization: 'per_action',
  },
  local_command: {
    target: 'local',
    tools: ['local.process.execute'],
    capabilities: ['storage:write'],
    actions: ['local.process.execute'],
    authorization: 'per_action',
  },
  cloud_command: {
    target: 'cloud',
    tools: ['cloud.process.execute'],
    capabilities: ['storage:write'],
    actions: ['cloud.process.execute'],
    authorization: 'per_action',
  },
  cloud_browser: {
    target: 'cloud',
    tools: ['browser.workspace'],
    capabilities: ['network:outbound'],
    actions: ['cloud.browser.observe', 'cloud.browser.act'],
    authorization: 'per_action',
  },
  local_browser: {
    target: 'local',
    tools: ['local.browser.workspace'],
    capabilities: ['network:outbound'],
    actions: ['local.browser.observe', 'local.browser.act'],
    authorization: 'per_action',
  },
  cloud_mcp: {
    target: 'cloud',
    tools: ['cloud.mcp.call'],
    capabilities: ['secret:use', 'network:outbound'],
    actions: ['cloud.mcp.call'],
    authorization: 'per_action',
  },
  local_mcp: {
    target: 'local',
    tools: resolveEmployeeToolDependencies(['local.mcp.call']),
    capabilities: ['secret:use', 'storage:write'],
    actions: ['local.mcp.discover', 'local.mcp.call'],
    authorization: 'per_action',
  },
  assistants: {
    target: 'cloud_or_local',
    tools: ['assistant.delegate'],
    capabilities: ['model:invoke'],
    authorization: 'root_budget',
  },
  development: {
    target: 'local',
    tools: [...developmentWorkflowToolNames],
    capabilities: ['model:invoke', 'storage:read', 'storage:write'],
    actions: [
      'local.fs.list',
      'local.fs.read',
      'local.process.execute',
      'local.fs.changeset',
    ],
    authorization: 'per_action',
  },
  boost: {
    target: 'none',
    tools: [],
    capabilities: [],
    authorization: 'unavailable',
  },
  teamwork: {
    target: 'none',
    tools: [],
    capabilities: [],
    authorization: 'unavailable',
  },
};

export function projectWorkspacePrerequisites(
  f: ReadinessFacts,
): WorkspaceCapability[][] {
  return workspaceCapabilityIds.map((id) => {
    const d = definitions[id];
    const reasons: WorkspaceCapability[] = [];
    const add = (...args: Parameters<typeof result>) => {
      reasons.push(result(...args));
    };
    const result = (
      state: WorkspaceCapability['state'],
      reason: WorkspaceCapability['reason'],
      responsibleRole: WorkspaceCapability['responsibleRole'] = 'user',
      action: WorkspaceCapability['action'] = 'guide',
    ): WorkspaceCapability => ({
      id,
      state,
      reason,
      responsibleRole,
      action,
      target: d.target,
      releaseEnabled: f.flags[id],
      authorization: d.authorization,
    });
    if (id === 'boost' || id === 'teamwork')
      return [result('not_released', 'planned', 'platform_admin')];
    if (!f.flags[id]) add('not_released', 'release_disabled', 'platform_admin');
    if (!f.canExecute) add('needs_authorization', 'read_only', 'tenant_admin');
    if (!f.employee)
      add('needs_configuration', 'employee_missing', 'tenant_admin');
    if (
      d.tools.some((t) => !f.tools.includes(t)) ||
      d.capabilities.some(
        (c) => !f.capabilities.includes(c) || f.deniedCapabilities.includes(c),
      ) ||
      (id === 'cloud_mcp' && !f.cloudMcpPolicy) ||
      (id === 'local_mcp' && !f.localMcpPolicy)
    )
      add('needs_authorization', 'employee_policy', 'tenant_admin');
    const actions =
      id === 'local_files' && f.governedLocalReads
        ? ['local.fs.list', 'local.fs.read']
        : d.actions;
    if (actions || id === 'assistants') {
      if (!f.controls)
        add('needs_configuration', 'policy_missing', 'tenant_admin');
      if (
        f.controls &&
        (!f.controls.enabled ||
          (id !== 'local_files' && f.controls.mode !== 'execute') ||
          actions?.some(
            (a) =>
              !f.controls!.rules.some(
                (r) => r.action === a && r.effect !== 'deny',
              ) ||
              f.controls!.rules.some(
                (r) => r.action === a && r.effect === 'deny',
              ),
          ) ||
          ((id === 'assistants' || id === 'development') &&
            (!f.controls.rules.some(
              (r) => r.action === 'assistant.delegate' && r.effect === 'allow',
            ) ||
              f.controls.rules.some(
                (r) =>
                  r.action === 'assistant.delegate' && r.effect !== 'allow',
              ))))
      )
        add('needs_authorization', 'policy_denied', 'tenant_admin');
    }
    if (d.target === 'local') {
      if (f.bridge === 'missing')
        add('needs_configuration', 'bridge_missing', 'user', 'bridge');
      if (f.bridge === 'offline')
        add('device_offline', 'bridge_offline', 'user', 'bridge');
      if (f.preparation?.paused)
        add('device_offline', 'device_paused', 'user', 'bridge');
      const preparation =
        id === 'local_browser'
          ? f.preparation?.browser
          : id === 'development'
            ? (f.preparation?.development ?? f.preparation?.sandbox)
            : id === 'local_command'
              ? f.preparation?.sandbox
              : undefined;
      if (preparation === 'preparing')
        add('preparing', 'environment_preparing', 'user', 'guide');
      if (preparation === 'paused')
        add('device_offline', 'device_paused', 'user', 'bridge');
      if (id === 'local_browser' && preparation === 'unavailable')
        add('needs_configuration', 'browser_unavailable', 'user', 'bridge');
      // Local browser is independent of filesystem and command sandbox grants.
      if (id !== 'local_browser' && !f.folder)
        add('needs_configuration', 'folder_missing', 'user', 'bridge');
      if (
        ['local_command', 'local_mcp', 'development'].includes(id) &&
        !f.runner
      )
        add('needs_configuration', 'runner_missing', 'user');
      if (id === 'development' && !f.developmentRunner)
        add(
          'needs_configuration',
          'candidate_runner_missing',
          'user',
          'bridge',
        );
    }
    const environment =
      id === 'cloud_command'
        ? f.cloud
        : id === 'cloud_browser'
          ? f.cloudBrowser
          : id === 'local_browser'
            ? f.localBrowser
            : null;
    if (environment && environment !== 'ready') {
      const action = f.canAdminister
        ? id === 'cloud_browser'
          ? 'browser_settings'
          : id === 'local_browser'
            ? 'local_browser_settings'
            : 'guide'
        : 'guide';
      if (environment === 'missing')
        add(
          'needs_configuration',
          'target_missing',
          id === 'local_browser' ? 'user' : 'platform_admin',
          action,
        );
      if (environment === 'unavailable')
        add(
          id === 'local_browser' ? 'device_offline' : 'needs_configuration',
          'target_unavailable',
          id === 'local_browser' ? 'user' : 'platform_admin',
          action,
        );
      if (environment === 'invalid')
        add('unknown', 'invalid_configuration', 'platform_admin');
      if (environment === 'ungranted')
        add('needs_authorization', 'grant_missing', 'tenant_admin', action);
    }
    // Published cloud tools can establish a member's connection in the task.
    // A private account's login state is not a platform capability prerequisite.
    const connection = id === 'local_mcp' ? f.localMcp : null;
    if (connection && connection !== 'ready') {
      const reason =
        connection === 'missing'
          ? 'connection_missing'
          : connection === 'unverified'
            ? 'connection_unverified'
            : 'connection_grant_missing';
      add(
        connection === 'ungranted'
          ? 'needs_authorization'
          : 'needs_configuration',
        reason,
        'tenant_admin',
        f.canAdminister ? 'mcp_settings' : 'guide',
      );
    }
    if (
      (id === 'assistants' || id === 'development') &&
      !['openai-codex', 'gemini', 'google', 'openai-compatible'].includes(
        f.provider,
      )
    )
      add('needs_configuration', 'provider_unsupported', 'tenant_admin');
    return reasons.length
      ? reasons
      : [
          result(
            'ready',
            id === 'cloud_mcp' && f.cloudMcp !== 'ready'
              ? 'connection_on_demand'
              : 'ready',
            'user',
            'compose',
          ),
        ];
  });
}

/** Existing tenant tiles retain their first-action projection. Admins can inspect
 * every independently missing prerequisite without weakening dispatch checks. */
export function projectWorkspaceReadiness(
  f: ReadinessFacts,
): WorkspaceCapability[] {
  return projectWorkspacePrerequisites(f).map((reasons) => reasons[0]!);
}
