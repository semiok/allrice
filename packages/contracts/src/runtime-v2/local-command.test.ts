import { describe, expect, it } from 'vitest';

import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandToolInputSchema,
  localCommandToolchainImageV1,
} from './local-command.ts';

const input = {
  executable: '/usr/local/bin/node',
  args: ['test.mjs'],
  path: '.',
  files: [{ path: 'test.mjs', sha256: `sha256:${'a'.repeat(64)}` }],
  limits: {
    timeoutMs: 60_000,
    outputBytes: 65_536,
    memoryMiB: 128,
    cpuMillis: 1000,
    pids: 32,
  },
};

describe('local command process and native-thread capacity', () => {
  it.each([16, 31, 65])(
    'rejects new requests with pids=%s before approval',
    (pids) => {
      const parsed = RuntimeLocalCommandToolInputSchema.safeParse({
        ...input,
        limits: { ...input.limits, pids },
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.issues.map((issue) => issue.path)).toEqual([
          ['limits', 'pids'],
        ]);
    },
  );

  it.each([32, 64])('preserves the exact approved capacity pids=%s', (pids) => {
    const request = { ...input, limits: { ...input.limits, pids } };
    expect(RuntimeLocalCommandToolInputSchema.parse(request)).toEqual(request);
  });

  it('retains historical wire payloads without silently raising approved limits', () => {
    const payload = {
      capability: 'local.process.execute',
      arguments: {
        ...input,
        limits: { ...input.limits, pids: 16 },
        imageDigest: localCommandToolchainImageV1,
        isolation: 'local-vm-container-v1',
        network: 'none',
      },
    };
    expect(RuntimeLocalCommandSchema.parse(payload)).toEqual(payload);
  });
});
