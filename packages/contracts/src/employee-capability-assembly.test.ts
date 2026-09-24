import { expect, it } from 'vitest';
import {
  assembleEmployeeCapabilities,
  developmentWorkflowToolNames,
  employeePublicationPolicy,
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
  expect(removed.capabilities.toolNames).toEqual(result.capabilities.toolNames);
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
