import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  riceReadOnlyToolDefinitionsForPreview,
  riceToolDefinitionsForCapabilities,
  riceToolDefinitionsForTurn,
} from './definitions.js';
import { riceToolHandlerRegistry } from './registry.js';
import { randomUUID } from 'node:crypto';
import { FrozenMcpToolSchema, allRiceToolManifest } from '@allrice/contracts';

const granted = ['cloud.mcp.call', 'automation.create'];
const frozen = [
  FrozenMcpToolSchema.parse({
    connectionId: randomUUID(),
    connectionRevision: 1,
    name: 'records.list',
    description: 'Synthetic',
    inputSchema: { type: 'object' },
    outputSchema: null,
    toolRevisionId: randomUUID(),
    digest: `sha256:${'a'.repeat(64)}`,
    grantRevision: 1,
    risk: 'read_only',
    credentialReference: 'opaque:synthetic',
    employeeAuthorization: {
      id: randomUUID(),
      revision: 1,
      employeeId: randomUUID(),
      employeeVersionId: randomUUID(),
    },
  }),
];
const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
const enable = () => {
  vi.stubEnv('ALLRICE_CLOUD_MCP_ENABLED', '1');
  vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
};
afterEach(() => vi.unstubAllEnvs());

describe('P16 explicit MCP visibility is never execution permission', () => {
  it('requires an independent grant design before any future secret tool can inherit a tenant MCP capability', () => {
    expect(
      allRiceToolManifest
        .filter((t) => t.capability === 'secret:use')
        .map((t) => t.canonicalName),
    ).toEqual(['local.mcp.discover', 'local.mcp.call', 'cloud.mcp.call']);
  });
  it('requires a frozen manifest allowlist and secret:use independently', () => {
    enable();
    expect(
      names(riceToolDefinitionsForCapabilities(['secret:use'])),
    ).not.toContain('cloud.mcp.call');
    expect(
      names(riceToolDefinitionsForCapabilities(['storage:write'], granted)),
    ).not.toContain('cloud.mcp.call');
    expect(
      names(riceToolDefinitionsForCapabilities(['secret:use'], granted, [])),
    ).not.toContain('cloud.mcp.call');
    const legacy = { ...frozen[0]!, employeeAuthorization: undefined };
    expect(
      names(
        riceToolDefinitionsForCapabilities(['secret:use'], granted, [legacy]),
      ),
    ).not.toContain('cloud.mcp.call');
  });
  it.each(['ALLRICE_CLOUD_MCP_ENABLED', 'ALLRICE_RUNTIME_POLICY_ENABLED'])(
    'requires %s even with both frozen allowlist and capability',
    (flag) => {
      enable();
      vi.stubEnv(flag, '0');
      expect(
        names(
          riceToolDefinitionsForCapabilities(['secret:use'], granted, frozen),
        ),
      ).not.toContain('cloud.mcp.call');
    },
  );
  it('lets native DSH select only the exact-approval MCP adapter without exposing unrelated side effects or preview execution', () => {
    enable();
    vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '0');
    expect(
      names(
        riceToolDefinitionsForTurn(
          ['secret:use', 'automation:write'],
          granted,
          [],
          frozen,
        ),
      ),
    ).toEqual(['cloud.mcp.call']);
    expect(
      names(
        riceReadOnlyToolDefinitionsForPreview(
          ['secret:use', 'automation:write'],
          granted,
        ),
      ),
    ).not.toContain('cloud.mcp.call');
    expect(riceToolHandlerRegistry['cloud.mcp.call'].category).toBe(
      'cloud_mcp',
    );
  });
});
