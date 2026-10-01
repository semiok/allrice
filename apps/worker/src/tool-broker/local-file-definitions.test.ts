import { expect, it, vi } from 'vitest';
import { riceToolDefinitionsForCapabilities } from './definitions.js';

it('requires frozen local file tool selection and corresponding granted capability', () => {
  vi.stubEnv('ALLRICE_RUNTIME_POLICY_ENABLED', '1');
  vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '1');
  try {
    expect(
      riceToolDefinitionsForCapabilities([
        'storage:read',
        'storage:write',
      ]).some((d) => d.name.startsWith('local.file.')),
    ).toBe(false);
    expect(
      riceToolDefinitionsForCapabilities(
        ['storage:read'],
        ['local.file.inspect', 'local.file.save'],
      )
        .filter((d) => d.name.startsWith('local.file.'))
        .map((d) => d.name),
    ).toEqual(['local.file.inspect']);
    expect(
      riceToolDefinitionsForCapabilities(
        ['storage:read', 'storage:write'],
        ['local.file.inspect', 'local.file.save'],
      )
        .filter((d) => d.name.startsWith('local.file.'))
        .map((d) => d.name),
    ).toEqual(['local.file.inspect', 'local.file.save']);
    vi.stubEnv('ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED', '0');
    expect(
      riceToolDefinitionsForCapabilities(
        ['storage:read', 'storage:write'],
        ['local.file.save'],
      ).some((d) => d.name.startsWith('local.file.')),
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
