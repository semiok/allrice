import { describe, expect, it } from 'vitest';
import { workspaceCapabilityIds } from '@allrice/contracts';
import {
  projectWorkspaceReadiness,
  type ReadinessFacts,
} from './workspace-readiness-projector.ts';

export function readinessFixture(): ReadinessFacts {
  const tools = [
    'workspace.export.create',
    'local.fs.list',
    'local.fs.read',
    'local.fs.write',
    'local.process.execute',
    'cloud.process.execute',
    'browser.workspace',
    'local.browser.workspace',
    'cloud.mcp.call',
    'local.mcp.discover',
    'local.mcp.call',
    'assistant.delegate',
    'assistant.development',
    'assistant.report',
  ];
  const actions = [
    ...tools,
    'local.fs.changeset',
    'cloud.browser.observe',
    'cloud.browser.act',
    'local.browser.observe',
    'local.browser.act',
  ];
  return {
    canAdminister: false,
    canExecute: true,
    employee: true,
    tools,
    capabilities: [
      'model:invoke',
      'storage:read',
      'storage:write',
      'network:outbound',
      'secret:use',
    ],
    deniedCapabilities: [],
    provider: 'openai-codex',
    controls: {
      version: 1,
      enabled: true,
      mode: 'execute',
      rules: actions.map((action) => ({ action, effect: 'allow' })),
    },
    governedLocalReads: true,
    bridge: 'online',
    folder: true,
    runner: true,
    developmentRunner: true,
    cloud: 'ready',
    cloudBrowser: 'ready',
    localBrowser: 'ready',
    cloudMcp: 'ready',
    localMcp: 'ready',
    cloudMcpPolicy: true,
    localMcpPolicy: true,
    flags: Object.fromEntries(
      workspaceCapabilityIds.map((id) => [
        id,
        !['boost', 'teamwork'].includes(id),
      ]),
    ) as ReadinessFacts['flags'],
  };
}
const item = (f: ReadinessFacts, id: string) =>
  projectWorkspaceReadiness(f).find((c) => c.id === id)!;
describe('MET-147 capability matrix: discovery is not authority', () => {
  it('development requires the complete tools, candidate runner and explicit delegation allow', () => {
    const f = readinessFixture();
    expect(item(f, 'development')).toMatchObject({
      state: 'ready',
      target: 'local',
      authorization: 'per_action',
    });
    f.developmentRunner = false;
    expect(item(f, 'development').reason).toBe('candidate_runner_missing');
    expect(item(f, 'local_command').state).toBe('ready');
    f.developmentRunner = true;
    f.tools = f.tools.filter((t) => t !== 'assistant.report');
    expect(item(f, 'development').reason).toBe('employee_policy');
    f.tools.push('assistant.report');
    f.controls!.rules.push({ action: 'assistant.delegate', effect: 'ask' });
    expect(item(f, 'development').reason).toBe('policy_denied');
    f.flags.development = false;
    expect(item(f, 'development').reason).toBe('release_disabled');
  });
  it('offers implemented capabilities with original per-action/root-budget boundaries', () => {
    const f = readinessFixture();
    expect(
      projectWorkspaceReadiness(f).filter((c) => c.state === 'ready'),
    ).toHaveLength(11);
    expect(item(f, 'local_command').authorization).toBe('per_action');
    expect(item(f, 'assistants').authorization).toBe('root_budget');
    expect(item(f, 'boost')).toMatchObject({
      state: 'not_released',
      reason: 'planned',
    });
  });
  it.each(['missing', 'offline'] as const)(
    'local %s never blocks independent cloud work',
    (bridge) => {
      const f = { ...readinessFixture(), bridge, folder: false, runner: false };
      expect(item(f, 'local_files').reason).toBe(
        bridge === 'missing' ? 'bridge_missing' : 'bridge_offline',
      );
      for (const id of [
        'report',
        'cloud_command',
        'cloud_browser',
        'cloud_mcp',
      ])
        expect(item(f, id).state).toBe('ready');
    },
  );
  it('does not equate online, folder granted and command sandbox ready', () => {
    const f = { ...readinessFixture(), folder: false, runner: false };
    expect(item(f, 'local_command').reason).toBe('folder_missing');
    expect(item(f, 'local_browser').state).toBe('ready');
    f.folder = true;
    expect(item(f, 'local_files').state).toBe('ready');
    expect(item(f, 'local_command').reason).toBe('runner_missing');
  });
  it.each(workspaceCapabilityIds)(
    'release-off %s is visible but never executable',
    (id) => {
      const f = readinessFixture();
      f.flags[id] = false;
      expect(item(f, id).state).toBe('not_released');
      expect(item(f, id).action).not.toBe('compose');
    },
  );
  it('checks deny, plan-only, missing rules and delegation allow-only', () => {
    const f = readinessFixture();
    f.controls!.rules.push({ action: 'local.process.execute', effect: 'deny' });
    expect(item(f, 'local_command').reason).toBe('policy_denied');
    f.controls!.rules.push({ action: 'assistant.delegate', effect: 'ask' });
    expect(item(f, 'assistants').reason).toBe('policy_denied');
    f.controls!.mode = 'plan_only';
    expect(item(f, 'local_files').state).toBe('ready');
    expect(item(f, 'cloud_command').reason).toBe('policy_denied');
    f.controls!.rules = [];
    expect(item(f, 'local_files').reason).toBe('policy_denied');
    f.controls = null;
    expect(item(f, 'local_command').reason).toBe('policy_missing');
  });
  it('respects employee tool/capability denies, not just environment presence', () => {
    const f = readinessFixture();
    f.deniedCapabilities = ['storage:write'];
    expect(item(f, 'report').reason).toBe('employee_policy');
    f.tools = [];
    expect(item(f, 'local_files').reason).toBe('employee_policy');
  });
  it('does not expose admin configuration links to members', () => {
    const f = {
      ...readinessFixture(),
      cloudMcp: 'ungranted' as const,
      cloudBrowser: 'ungranted' as const,
    };
    expect(item(f, 'cloud_mcp')).toMatchObject({
      state: 'needs_authorization',
      action: 'guide',
      responsibleRole: 'tenant_admin',
    });
    expect(item(f, 'cloud_browser').action).toBe('guide');
    f.canAdminister = true;
    expect(item(f, 'cloud_mcp').action).toBe('mcp_settings');
    expect(item(f, 'cloud_browser').action).toBe('browser_settings');
  });
  it.each(['missing', 'unverified', 'ungranted'] as const)(
    'MCP %s is never ready',
    (cloudMcp) => {
      expect(
        item({ ...readinessFixture(), cloudMcp }, 'cloud_mcp').state,
      ).not.toBe('ready');
    },
  );
  it('unknown configuration and unsupported providers are explicit, not successful', () => {
    const f = {
      ...readinessFixture(),
      cloud: 'invalid' as const,
      provider: 'unknown',
    };
    expect(item(f, 'cloud_command')).toMatchObject({
      state: 'unknown',
      reason: 'invalid_configuration',
    });
    expect(item(f, 'assistants').reason).toBe('provider_unsupported');
    f.canExecute = false;
    expect(item(f, 'report').reason).toBe('read_only');
  });
});
