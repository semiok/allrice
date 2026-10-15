import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TenantQuotaChangeSchema,
  TenantQuotaLimitsSchema,
} from '../tenant-quotas.ts';
import { EmployeeExecutionSnapshotV2Schema } from '../employees.ts';
import {
  resolveSandboxExecutionPolicy,
  SandboxExecutionPolicySchema,
  SandboxExecutionLimitMsSchema,
  sandboxExecutionBudgetSpec,
  startSandboxExecutionBudget,
  renewSandboxExecutionBudget,
} from './sandbox-execution.ts';

describe('single sandbox execution policy', () => {
  const tenant = {
    scope: 'tenant' as const,
    scopeId: randomUUID(),
    source: 'tenant_override' as const,
    maxExecutionMs: 1_800_000 as const,
  };
  it('defaults only when absent, composes explicit caps and rejects inconsistent frozen policies', () => {
    expect(resolveSandboxExecutionPolicy([]).maxExecutionMs).toBe(600000);
    expect(resolveSandboxExecutionPolicy([tenant]).maxExecutionMs).toBe(
      1800000,
    );
    const user = {
      ...tenant,
      scope: 'user' as const,
      maxExecutionMs: 3600000 as const,
    };
    expect(resolveSandboxExecutionPolicy([tenant, user]).maxExecutionMs).toBe(
      1800000,
    );
    expect(
      resolveSandboxExecutionPolicy([
        tenant,
        { ...user, maxExecutionMs: 600000 },
      ]).maxExecutionMs,
    ).toBe(600000);
    expect(
      SandboxExecutionPolicySchema.safeParse({
        version: 1,
        maxExecutionMs: 3600000,
        sources: [tenant],
      }).success,
    ).toBe(false);
    expect(() => resolveSandboxExecutionPolicy([tenant, tenant])).toThrow();
  });
  it('accepts only the three finite caps and leaves legacy snapshots and requests absent', () => {
    for (const invalid of [
      0,
      60000,
      599999,
      600001,
      86400000,
      Infinity,
      '600000',
      null,
    ])
      expect(SandboxExecutionLimitMsSchema.safeParse(invalid).success).toBe(
        false,
      );
    const limits = {
      monthlyRunLimit: 2000,
      monthlyTokenLimit: 2000000,
      concurrentRunLimit: 3,
      maxRuntimeMs: 0,
    };
    expect(TenantQuotaLimitsSchema.parse(limits)).toEqual(limits);
    expect(
      EmployeeExecutionSnapshotV2Schema.shape.sandboxExecutionPolicy.parse(
        undefined,
      ),
    ).toBeUndefined();
    expect(
      TenantQuotaChangeSchema.safeParse({
        workspaceId: randomUUID(),
        subjectId: randomUUID(),
        scope: 'user',
        expectedVersion: null,
        reason: 'Invalid cap check',
        limits: { ...limits, maxSandboxExecutionMs: 0 },
      }).success,
    ).toBe(false);
  });
});

describe('finite sandbox execution extensions', () => {
  const begin = (cap: 600000 | 1800000 | 3600000 = 600000, root = 10_000_000) =>
    startSandboxExecutionBudget(
      sandboxExecutionBudgetSpec(
        { version: 1, kind: 'compute' },
        resolveSandboxExecutionPolicy([
          {
            scope: 'user',
            scopeId: '00000000-0000-4000-8000-000000000001',
            source: 'tenant_override',
            maxExecutionMs: cap,
          },
        ]),
      ),
      1_000_000,
      root,
    );
  const request = (sequence: number, cpuNanos = sequence * 10_000_000) => ({
    requestId: randomUUID(),
    sequence,
    progress: { cpuNanos, readBytes: 0, writtenBytes: 0 },
  });
  it.each([600000, 1800000, 3600000] as const)(
    'keeps one start and hard cap through every approved extension: %s',
    (cap) => {
      let state = begin(cap);
      while (state.deadlineAt < state.hardDeadlineAt) {
        state = renewSandboxExecutionBudget(
          state,
          request(state.sequence + 1),
          state.deadlineAt - 10000,
          10_000_000,
        );
        expect(state.startedAt).toBe(1_000_000);
        expect(state.hardDeadlineAt).toBe(1_000_000 + cap);
      }
      expect(() =>
        renewSandboxExecutionBudget(
          state,
          request(state.sequence + 1),
          state.deadlineAt - 10000,
          10_000_000,
        ),
      ).toThrow('LIMIT');
      expect(state.deadlineAt - state.startedAt).toBe(cap);
      expect(state.renewals).toHaveLength(cap / 60000 - 1);
    },
  );
  it('clamps to root remaining time even when the single-operation cap is longer', () => {
    const state = begin(3600000, 1_075_000);
    expect(state.hardDeadlineAt).toBe(1_075_000);
    const next = renewSandboxExecutionBudget(
      state,
      request(1),
      1_050_000,
      1_075_000,
    );
    expect(next.deadlineAt).toBe(1_075_000);
    expect(() =>
      renewSandboxExecutionBudget(next, request(2), 1_075_000, 10_000_000),
    ).toThrow('DEADLINE');
  });
  it('deduplicates exact retries, refuses changed/out-of-order requests and never revives expired work', () => {
    const state = begin(),
      one = request(1);
    const next = renewSandboxExecutionBudget(state, one, 1_050_000, 10_000_000);
    expect(
      renewSandboxExecutionBudget(next, one, 1_055_000, 10_000_000),
    ).toEqual(next);
    expect(() =>
      renewSandboxExecutionBudget(
        next,
        { ...one, progress: { ...one.progress, cpuNanos: 99 } },
        1_055_000,
        10_000_000,
      ),
    ).toThrow('CONFLICT');
    expect(() =>
      renewSandboxExecutionBudget(next, request(3), 1_110_000, 10_000_000),
    ).toThrow('CONFLICT');
    expect(() =>
      renewSandboxExecutionBudget(state, one, 1_060_000, 10_000_000),
    ).toThrow('DEADLINE');
    expect(() =>
      renewSandboxExecutionBudget(state, one, 1_010_000, 10_000_000),
    ).toThrow('EARLY');
  });
  it('does not equate heartbeats with progress, but accepts CPU or actual transfer without stdout', () => {
    let state = begin();
    state = renewSandboxExecutionBudget(
      state,
      request(1, 0),
      1_050_000,
      10_000_000,
    );
    state = renewSandboxExecutionBudget(
      state,
      request(2, 0),
      1_110_000,
      10_000_000,
    );
    expect(() =>
      renewSandboxExecutionBudget(state, request(3, 0), 1_170_000, 10_000_000),
    ).toThrow('NO_PROGRESS');
    const transfer = {
      ...request(3, 0),
      progress: { cpuNanos: 0, readBytes: 1024, writtenBytes: 0 },
    };
    const next = renewSandboxExecutionBudget(
      state,
      transfer,
      1_170_000,
      10_000_000,
    );
    expect(next.lastProgressAt).toBe(1_170_000);
    expect(() =>
      renewSandboxExecutionBudget(next, request(4, 0), 1_230_000, 10_000_000),
    ).toThrow('PROGRESS_CHANGED');
  });
});
