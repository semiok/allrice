import { describe, expect, it } from 'vitest';

import {
  RuntimeLocalCommandSchema,
  RuntimeLocalCommandToolInputSchema,
  localCommandToolchainImageV1,
} from './local-command.ts';
import {
  sandboxExecutionBudgetSpec,
  resolveSandboxExecutionPolicy,
} from './sandbox-execution.ts';

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
  it('requires a matching frozen budget without letting tool arguments supply the cap', () => {
    const execution = { version: 1 as const, kind: 'compute' as const };
    const args = { ...input, execution };
    expect(RuntimeLocalCommandToolInputSchema.parse(args)).toEqual(args);
    const budget = sandboxExecutionBudgetSpec(
      execution,
      resolveSandboxExecutionPolicy([]),
    );
    expect(
      RuntimeLocalCommandToolInputSchema.safeParse({
        ...args,
        executionBudget: budget,
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalCommandToolInputSchema.safeParse({
        ...input,
        execution: { ...execution, maxExecutionMs: 3600000 },
      }).success,
    ).toBe(false);
    const payload = {
      capability: 'local.process.execute',
      executionBudget: budget,
      arguments: {
        ...args,
        imageDigest: localCommandToolchainImageV1,
        isolation: 'local-vm-container-v1',
        network: 'none',
      },
    };
    expect(RuntimeLocalCommandSchema.parse(payload)).toEqual(payload);
    expect(
      RuntimeLocalCommandSchema.safeParse({
        ...payload,
        executionBudget: undefined,
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalCommandSchema.safeParse({
        ...payload,
        arguments: { ...payload.arguments, execution: undefined },
      }).success,
    ).toBe(false);
    expect(
      RuntimeLocalCommandSchema.safeParse({
        ...payload,
        executionBudget: {
          ...budget,
          kind: 'install',
          initialBudgetMs: 120000,
        },
      }).success,
    ).toBe(false);
  });
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
