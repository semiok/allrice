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
