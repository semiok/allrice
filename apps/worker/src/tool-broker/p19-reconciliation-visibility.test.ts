import type { SkillCapability } from '@allrice/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  riceReadOnlyToolDefinitionsForPreview,
  riceToolDefinitionsForCapabilities,
  riceToolDefinitionsForTurn,
} from './definitions.js';

const name = 'workspace.reconciliation.export';
const capabilities: SkillCapability[] = ['storage:read', 'storage:write'];
const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
afterEach(() => vi.unstubAllEnvs());

function enable() {
  vi.stubEnv('ALLRICE_CLOUD_RUNNER_ENABLED', '1');
  vi.stubEnv('ALLRICE_WORKBENCH_ENABLED', '1');
}

describe('P19 frozen deterministic reconciliation export admission', () => {
  it('requires an explicit frozen grant rather than granting old employees a new writer', () => {
    enable();
    expect(
      names(riceToolDefinitionsForCapabilities(capabilities)),
    ).not.toContain(name);
    expect(
      names(riceToolDefinitionsForCapabilities(capabilities, [])),
    ).not.toContain(name);
    expect(
      names(riceToolDefinitionsForCapabilities(capabilities, [name])),
    ).toContain(name);
  });

  it.each(['ALLRICE_CLOUD_RUNNER_ENABLED', 'ALLRICE_WORKBENCH_ENABLED'])(
    'is hidden when %s is closed even with an employee grant',
    (flag) => {
      enable();
      vi.stubEnv(flag, '0');
      expect(
        names(riceToolDefinitionsForCapabilities(capabilities, [name])),
      ).not.toContain(name);
    },
  );

  it('requires storage write, is selectable by native DSH, and is never a read-only preview tool', () => {
    enable();
    expect(
      names(riceToolDefinitionsForCapabilities(['storage:read'], [name])),
    ).not.toContain(name);
    expect(
      names(
        riceToolDefinitionsForTurn(
          capabilities,
          [name, 'automation.create'],
          [],
        ),
      ),
    ).toEqual([name]);
    expect(
      names(riceReadOnlyToolDefinitionsForPreview(capabilities, [name])),
    ).toEqual([]);
  });
});
