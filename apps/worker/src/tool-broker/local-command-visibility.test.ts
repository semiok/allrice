import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  riceReadOnlyToolDefinitionsForPreview,
  riceToolDefinitionsForTurn,
} from './definitions.js';

const flags = [
  'ALLRICE_LOCAL_COMMAND_ENABLED',
  'ALLRICE_RUNTIME_POLICY_ENABLED',
  'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
];
const enable = () => flags.forEach((flag) => vi.stubEnv(flag, '1'));
const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);
afterEach(() => vi.unstubAllEnvs());

describe('MET-147 real tenant local command admission', () => {
  it('lets native DSH choose an explicitly granted exact-approval command without a keyword route', () => {
    enable();
    expect(
      names(
        riceToolDefinitionsForTurn(
          ['storage:write', 'automation:write'],
          ['local.process.execute', 'automation.create'],
          [],
        ),
      ),
    ).toEqual(['local.process.execute']);
  });

  it.each(flags)('keeps command invisible when %s is off', (flag) => {
    enable();
    vi.stubEnv(flag, '0');
    expect(
      riceToolDefinitionsForTurn(
        ['storage:write'],
        ['local.process.execute'],
        [],
      ),
    ).toEqual([]);
  });

  it('does not grant a command through broad storage access, old manifests or a selected route alone', () => {
    enable();
    for (const allowed of [undefined, []]) {
      expect(
        names(
          riceToolDefinitionsForTurn(['storage:write'], allowed, [
            'local.process.execute',
          ]),
        ),
      ).not.toContain('local.process.execute');
    }
    expect(
      riceToolDefinitionsForTurn(
        ['storage:read'],
        ['local.process.execute'],
        [],
      ),
    ).toEqual([]);
  });

  it('keeps platform read-only previews unable to execute', () => {
    enable();
    expect(
      riceReadOnlyToolDefinitionsForPreview(
        ['storage:write'],
        ['local.process.execute'],
      ),
    ).toEqual([]);
  });
});
