import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeGovernedToolNames,
  riceReadOnlyToolDefinitionsForPreview,
  riceToolDefinitionsForCapabilities,
  riceToolDefinitionsForTurn,
} from './definitions.js';
import { riceToolHandlerRegistry } from './registry.js';
import { CloudCommandInputSchema } from '@allrice/contracts';

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
const granted = ['cloud.process.execute', 'automation.create'];
afterEach(() => vi.unstubAllEnvs());
const enable = () => {
  vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
  vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
};

describe('P15 native exact-approval visibility, no new DSH transport', () => {
  it('does not authorize old manifests or a missing storage capability', () => {
    enable();
    expect(
      names(riceToolDefinitionsForCapabilities(['storage:write'])),
    ).not.toContain('cloud.process.execute');
    expect(
      names(riceToolDefinitionsForCapabilities(['storage:read'], granted)),
    ).not.toContain('cloud.process.execute');
  });
  it.each(['ALLRICE_CLOUD_RUNNER_ENABLED', 'ALLRICE_RUNTIME_POLICY_ENABLED'])(
    'requires %s as well as the exact frozen grant',
    (flag) => {
      enable();
      vi.stubEnv(flag, '0');
      expect(
        names(riceToolDefinitionsForCapabilities(['storage:write'], granted)),
      ).not.toContain('cloud.process.execute');
    },
  );
  it('lets the native loop choose cloud without keyword routing, but does not expose other unselected side effects or preview execution', () => {
    enable();
    // Other governed tools may be added; the frozen allowlist below must still
    // expose only this test's selected cloud action, never those other tools.
    expect([...nativeGovernedToolNames]).toEqual(
      expect.arrayContaining([
        'cloud.process.execute',
        'cloud.mcp.call',
        'local.mcp.discover',
        'local.mcp.call',
      ]),
    );
    expect(
      names(
        riceToolDefinitionsForTurn(
          ['storage:write', 'automation:write'],
          granted,
          [],
        ),
      ),
    ).toEqual(['cloud.process.execute']);
    expect(
      names(riceReadOnlyToolDefinitionsForPreview(['storage:write'], granted)),
    ).not.toContain('cloud.process.execute');
    expect(riceToolHandlerRegistry['cloud.process.execute'].category).toBe(
      'cloud_runner',
    );
    expect(
      CloudCommandInputSchema.safeParse({
        script: 'console.log(1)',
        network: 'host',
      }).success,
    ).toBe(false);
  });
});
