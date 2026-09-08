import { describe, it, expect } from 'vitest';
import { employeeManifest } from './employees/employee-config.ts';
import { mcpEmployeeEligibility } from './mcp-employee-bindings.ts';

const candidate = () =>
  employeeManifest({
    key: 'mcp',
    name: 'MCP employee',
    description: 'Synthetic',
    toolNames: ['cloud.mcp.call'],
    securityPolicy: {
      dataScopes: ['workspace'],
      connectorIdentityModes: ['service'],
      approvalPolicy: 'confirm_side_effects',
      deniedCapabilities: [],
    },
  });
describe('MCP employee grants only narrow immutable policy', () => {
  it('accepts an explicitly declared controlled service policy without fabricated Skills', () =>
    expect(mcpEmployeeEligibility(candidate())).toEqual([]));
  it.each(['secret:use', 'network:outbound'] as const)(
    'Deny wins over declared %s and tenant grants',
    (cap) => {
      const policy = candidate();
      if (policy.schemaVersion !== 2) throw Error('v2 expected');
      policy.securityPolicy.deniedCapabilities.push(cap);
      expect(mcpEmployeeEligibility(policy)).toContain(
        `员工策略明确禁止 ${cap}`,
      );
    },
  );
  it('requires exact tool, capabilities and service identity; historical manifests do not become eligible', () => {
    const policy = candidate();
    if (policy.schemaVersion !== 2) throw Error('v2 expected');
    policy.capabilityBindings.toolNames = [];
    policy.capabilities = policy.capabilities.filter((c) => c !== 'secret:use');
    policy.securityPolicy.connectorIdentityModes = ['user'];
    expect(mcpEmployeeEligibility(policy)).toHaveLength(3);
    expect(mcpEmployeeEligibility({})).toEqual(['需要发布新版员工策略']);
  });
});
