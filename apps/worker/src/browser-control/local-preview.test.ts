import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalPreviewOpenInputSchema } from '@allrice/contracts';
import {
  riceToolDefinitionsForCapabilities,
  nativeGovernedToolNames,
} from '../tool-broker/definitions.js';
afterEach(() => vi.unstubAllEnvs());
describe('native service preview input and visibility', () => {
  it('accepts only process identity and denies host/port/authority injection', () => {
    const input = { processId: randomUUID() };
    expect(LocalPreviewOpenInputSchema.parse(input)).toEqual(input);
    for (const extra of [
      { url: 'https://localhost' },
      { port: 3100 },
      { containerId: 'a'.repeat(64) },
      { jobLeaseToken: randomUUID() },
      { runId: randomUUID() },
    ])
      expect(
        LocalPreviewOpenInputSchema.safeParse({ ...input, ...extra }).success,
      ).toBe(false);
  });
  it('requires explicit frozen tool, network capability and every feature flag', () => {
    const flags = [
      'ALLRICE_LOCAL_PREVIEW_ENABLED',
      'ALLRICE_LOCAL_BROWSER_ENABLED',
      'ALLRICE_BROWSER_CONTROL_ENABLED',
      'ALLRICE_RUNTIME_POLICY_ENABLED',
      'ALLRICE_LOCAL_COMMAND_ENABLED',
      'ALLRICE_LOCAL_SERVICE_ENABLED',
      'ALLRICE_BRIDGE_OPERATION_LEDGER_ENABLED',
    ];
    for (const flag of flags) vi.stubEnv(flag, '1');
    const names = (
      capabilities: Parameters<typeof riceToolDefinitionsForCapabilities>[0] = [
        'network:outbound',
      ],
      allowed = ['local.preview.open'],
    ) =>
      riceToolDefinitionsForCapabilities(capabilities, allowed).map(
        (x) => x.name,
      );
    expect(names()).toContain('local.preview.open');
    expect(nativeGovernedToolNames.has('local.preview.open')).toBe(true);
    expect(names([], ['local.preview.open'])).not.toContain(
      'local.preview.open',
    );
    expect(names(['network:outbound'], [])).not.toContain('local.preview.open');
    for (const flag of flags) {
      vi.stubEnv(flag, '0');
      expect(names()).not.toContain('local.preview.open');
      vi.stubEnv(flag, '1');
    }
  });
});
