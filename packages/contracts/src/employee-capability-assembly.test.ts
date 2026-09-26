import { expect, it } from 'vitest';
import {
  assembleEmployeeCapabilities,
  developmentWorkflowToolNames,
  employeePublicationPolicy,
  upgradeEmployeeSkillBindings,
  employeeToolDependencySources,
  resolveEmployeeToolDependencies,
} from './employee-tool-catalog.ts';
import type { PlatformEmployeeDefinition } from './platform-employees.ts';
function definition(): PlatformEmployeeDefinition {
  return {
    capabilities: {
      nativeSkillIds: ['selected'],
      toolNames: ['workspace.file.read'],
    },
    securityPolicy: {
      bridgeAccess: 'none',
      connectorIdentityModes: ['user'],
      deniedCapabilities: ['storage:write', 'secret:use'],
    },
  } as PlatformEmployeeDefinition;
}
const office = {
  id: 'office',
  replaces: ['document-analysis', 'structured-deliverable'],
  requiredToolRefs: [
    'workspace.document.read',
    'workspace.export.create',
    'workspace.skill.read',
  ],
};
it.each([
  ['document-analysis'],
  ['structured-deliverable'],
  ['document-analysis', 'structured-deliverable', 'office'],
])(
  'upgrades legacy bindings %j to one Office Skill with its dependencies',
  (...ids) => {
    const original = definition();
    original.capabilities.nativeSkillIds = [...ids, 'unrelated'];
    const result = upgradeEmployeeSkillBindings(original, [office]);
    expect(result.capabilities.nativeSkillIds).toEqual(['office', 'unrelated']);
    expect(result.capabilities.toolNames).toEqual(
      expect.arrayContaining(office.requiredToolRefs),
    );
    expect(result.securityPolicy.deniedCapabilities).toEqual(['secret:use']);
    expect(original.capabilities.nativeSkillIds).toEqual([...ids, 'unrelated']);
    expect(original.securityPolicy.deniedCapabilities).toContain(
      'storage:write',
    );
  },
);
it('does not reassemble an unrelated draft or silently undo a later explicit restriction', () => {
  const original = definition();
  expect(upgradeEmployeeSkillBindings(original, [office])).toBe(original);
  original.capabilities.nativeSkillIds = ['office'];
  expect(upgradeEmployeeSkillBindings(original, [office])).toBe(original);
  expect(original.securityPolicy.deniedCapabilities).toContain('storage:write');
});
it('assembles the selected Skill dependencies and their employee permissions in the same edit', () => {
  const original = definition();
  const result = assembleEmployeeCapabilities(original, [
    {
      id: 'selected',
      requiredToolRefs: ['cloud.process.execute', 'workspace.export.create'],
    },
    { id: 'unselected', requiredToolRefs: ['local.mcp.call'] },
  ]);
  expect(result.capabilities.toolNames).toEqual([
    'workspace.file.read',
    'cloud.process.execute',
    'workspace.export.create',
  ]);
  expect(result.securityPolicy.deniedCapabilities).toEqual(['secret:use']);
  expect(original.securityPolicy.deniedCapabilities).toContain('storage:write');
  const removed = assembleEmployeeCapabilities(
    { ...result, capabilities: { ...result.capabilities, nativeSkillIds: [] } },
    [],
  );
  expect(removed.capabilities.toolNames).toEqual(['workspace.file.read']);
});

it('retains shared dependencies and manual choices after save/reload and successive Skill removals', () => {
  const skills = [
    {
      id: 'selected',
      name: 'Reports',
      requiredToolRefs: ['cloud.process.execute', 'workspace.export.create'],
    },
    {
      id: 'second',
      name: 'Analysis',
      requiredToolRefs: ['cloud.process.execute', 'web.search'],
    },
  ];
  const original = definition();
  original.capabilities.nativeSkillIds = ['selected', 'second'];
  const both = assembleEmployeeCapabilities(original, skills);
  // The UI's "单独保留" persists as editing provenance alongside the draft.
  both.capabilities.explicitToolNames!.push('workspace.export.create');
  const reloaded = JSON.parse(
    JSON.stringify(both),
  ) as PlatformEmployeeDefinition;
  reloaded.capabilities.nativeSkillIds = ['second'];
  const one = assembleEmployeeCapabilities(reloaded, skills);
  expect(one.capabilities.toolNames).toEqual([
    'workspace.file.read',
    'workspace.export.create',
    'cloud.process.execute',
    'web.search',
  ]);
  expect(
    employeeToolDependencySources(one, skills)['cloud.process.execute'],
  ).toEqual(['Analysis']);
  one.capabilities.nativeSkillIds = [];
  expect(
    assembleEmployeeCapabilities(one, skills).capabilities.toolNames,
  ).toEqual(['workspace.file.read', 'workspace.export.create']);
  expect(original.capabilities.explicitToolNames).toBeUndefined();
});

it('does not infer ownership of any tool in a historical definition', () => {
  const old = definition();
  old.capabilities.nativeSkillIds = [];
  old.capabilities.toolNames = [
    'workspace.file.read',
    'workspace.export.create',
    'cloud.process.execute',
  ];
  const migrated = assembleEmployeeCapabilities(old, []);
  expect(migrated.capabilities.toolNames).toEqual(old.capabilities.toolNames);
  expect(migrated.capabilities.explicitToolNames).toEqual(
    old.capabilities.toolNames,
  );
});

it('resolves mutual MCP prerequisites once and removes them with the last owning Skill', () => {
  const skills = [{ id: 'selected', requiredToolRefs: ['local.mcp.call'] }];
  const enabled = assembleEmployeeCapabilities(definition(), skills);
  expect(resolveEmployeeToolDependencies(['local.mcp.call'])).toEqual([
    'local.mcp.call',
    'local.mcp.discover',
  ]);
  enabled.capabilities.nativeSkillIds = [];
  const removed = assembleEmployeeCapabilities(enabled, skills);
  expect(removed.capabilities.toolNames).toEqual(['workspace.file.read']);
  expect(removed.securityPolicy.connectorIdentityModes).toEqual([
    'user',
    'service',
  ]);
});
it('selecting MCP assembles its identity permission and local discovery dependency', () => {
  const input = definition();
  input.capabilities.toolNames = ['local.mcp.call'];
  const result = assembleEmployeeCapabilities(input, []);
  expect(result.capabilities.toolNames).toContain('local.mcp.discover');
  expect(result.securityPolicy.connectorIdentityModes).toEqual([
    'user',
    'service',
  ]);
  expect(result.securityPolicy.deniedCapabilities).not.toContain('secret:use');
  expect(result.securityPolicy.deniedCapabilities).not.toContain(
    'storage:write',
  );
});
it('makes a development selection include the whole delivery workflow and required Bridge mode', () => {
  const input = definition();
  input.capabilities.toolNames = ['assistant.development'];
  const result = assembleEmployeeCapabilities(input, []);
  expect(result.capabilities.toolNames).toEqual(
    expect.arrayContaining([...developmentWorkflowToolNames]),
  );
  expect(result.securityPolicy.bridgeAccess).toBe('read_write');
  expect(result.securityPolicy.deniedCapabilities).not.toContain(
    'storage:write',
  );
});
it('publishing selected tools enables their rules while retaining unrelated restrictions', () => {
  const policy = employeePublicationPolicy(
    {
      version: 2,
      enabled: false,
      mode: 'plan_only',
      rules: [
        { action: 'assistant.delegate', effect: 'deny' },
        { action: 'cloud.mcp.call', effect: 'deny' },
      ],
    },
    ['assistant.delegate', 'local.process.execute'],
    3,
  );
  expect(policy).toEqual({
    version: 3,
    enabled: true,
    mode: 'execute',
    rules: [
      { action: 'cloud.mcp.call', effect: 'deny' },
      { action: 'assistant.delegate', effect: 'allow' },
      { action: 'local.process.execute', effect: 'allow' },
    ],
  });
});
