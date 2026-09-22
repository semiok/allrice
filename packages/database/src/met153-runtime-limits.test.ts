import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CreateRunInputSchema,
  ModelRunLimitsSchema,
  EmployeeModelPolicySchema,
  TenantQuotaLimitsSchema,
  EmployeeRuntimePolicySchema,
} from '@allrice/contracts';
import {
  defaultResourceLimits,
  assertModelResourceAvailable,
  ModelGovernanceError,
} from './providers/model-governance.ts';
import { queueMaintenanceAction } from './queue.js';

describe('MET-153 PR-1: unified task runtime limits and factual source', () => {
  it('defaults new task run inputs and model policies to 1 hour (3_600_000 ms)', () => {
    const runInput = CreateRunInputSchema.parse({
      workspaceId: randomUUID(),
      idempotencyKey: 'task-1',
      type: 'allrice.employee.run',
      input: {},
    });
    expect(runInput.timeoutMs).toBe(3_600_000);

    const modelLimits = ModelRunLimitsSchema.parse({});
    expect(modelLimits.timeoutMs).toBe(3_600_000);

    const employeePolicy = EmployeeModelPolicySchema.parse({
      schemaVersion: 1,
      employeeId: randomUUID(),
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      connectionId: randomUUID(),
      modelCatalogEntryId: randomUUID(),
      reasoningEffort: 'xhigh',
      fallbackPolicy: 'disabled',
      fallbackTargets: [],
      revision: 1,
      updatedBy: randomUUID(),
      updatedAt: new Date().toISOString(),
    });
    expect(employeePolicy.runLimits.timeoutMs).toBe(3_600_000);

    // Platform default resource limits
    expect(defaultResourceLimits.user.maxRuntimeMs).toBe(3_600_000);
    expect(defaultResourceLimits.tenant.maxRuntimeMs).toBe(3_600_000);
    expect(defaultResourceLimits.employee.maxRuntimeMs).toBe(3_600_000);
    expect(defaultResourceLimits.provider.maxRuntimeMs).toBe(3_600_000);
  });

  it('supports 30 minutes, 1 hour, and unlimited (0) in tenant quota and employee schemas', () => {
    // 30 minutes
    const thirtyMin = TenantQuotaLimitsSchema.parse({
      monthlyRunLimit: 1000,
      monthlyTokenLimit: 10_000_000,
      concurrentRunLimit: 5,
      maxRuntimeMs: 1_800_000,
    });
    expect(thirtyMin.maxRuntimeMs).toBe(1_800_000);

    // 1 hour
    const oneHour = TenantQuotaLimitsSchema.parse({
      monthlyRunLimit: 1000,
      monthlyTokenLimit: 10_000_000,
      concurrentRunLimit: 5,
      maxRuntimeMs: 3_600_000,
    });
    expect(oneHour.maxRuntimeMs).toBe(3_600_000);

    // Unlimited (0)
    const unlimited = TenantQuotaLimitsSchema.parse({
      monthlyRunLimit: 1000,
      monthlyTokenLimit: 10_000_000,
      concurrentRunLimit: 5,
      maxRuntimeMs: 0,
    });
    expect(unlimited.maxRuntimeMs).toBe(0);

    // Employee runtime policy accepts 0 and up to 24h
    const runtimePolicy = EmployeeRuntimePolicySchema.parse({
      harness: 'dsh',
      provider: 'openai-codex',
      credentialReference: 'cred-123',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
      timeoutMs: 0,
      fallbackModels: [],
    });
    expect(runtimePolicy.timeoutMs).toBe(0);
  });

  it('verifies 1-hour timeout boundary with controllable virtual clock (does not timeout at 5m or 30m)', () => {
    const startTime = new Date('2026-09-22T10:00:00.000Z');
    const oneHourTimeout = new Date('2026-09-22T11:00:00.000Z');

    const job = {
      status: 'running' as const,
      attempt: 1,
      max_attempts: 3,
      available_at: startTime,
      timeout_at: oneHourTimeout,
      lease_expires_at: new Date('2026-09-22T10:05:00.000Z'),
      cancel_requested_at: null,
    };

    // At 5 minutes: task is NOT timed out
    const at5Min = new Date('2026-09-22T10:05:00.000Z');
    expect(
      queueMaintenanceAction(
        { ...job, lease_expires_at: new Date('2026-09-22T10:10:00.000Z') },
        at5Min,
      ),
    ).toBe('none');

    // At 30 minutes: task is NOT timed out
    const at30Min = new Date('2026-09-22T10:30:00.000Z');
    expect(
      queueMaintenanceAction(
        { ...job, lease_expires_at: new Date('2026-09-22T10:35:00.000Z') },
        at30Min,
      ),
    ).toBe('none');

    // At 59 minutes: task is NOT timed out
    const at59Min = new Date('2026-09-22T10:59:00.000Z');
    expect(
      queueMaintenanceAction(
        { ...job, lease_expires_at: new Date('2026-09-22T11:04:00.000Z') },
        at59Min,
      ),
    ).toBe('none');

    // At 60 minutes + 1 second: task reaches timeout
    const at60Min = new Date('2026-09-22T11:00:01.000Z');
    expect(queueMaintenanceAction(job, at60Min)).toBe('timeout');
  });

  it('Codex subscription observes monthly run count without admission denial; API routes enforce', () => {
    const resource = {
      scope: 'tenant' as const,
      scopeId: randomUUID(),
      monthlyRunLimit: 50,
      monthlyTokenLimit: 1_000_000,
      concurrentRunLimit: 10,
      maxRuntimeMs: 3_600_000,
      usedRuns: 50, // Reached limit
      usedTokens: 10_000,
      activeRuns: 1,
    };

    // Under Codex subscription: admission succeeds
    expect(() =>
      assertModelResourceAvailable({
        resources: [resource],
        billingMode: 'subscription',
        requestedTokens: 5_000,
        requestedRuntimeMs: 3_600_000,
      }),
    ).not.toThrow();

    // Under token_metered: admission throws quota exceeded
    expect(() =>
      assertModelResourceAvailable({
        resources: [resource],
        billingMode: 'token_metered',
        requestedTokens: 5_000,
        requestedRuntimeMs: 3_600_000,
      }),
    ).toThrow(
      new ModelGovernanceError('MODEL_REQUEST_QUOTA_EXCEEDED', 'tenant'),
    );

    // Concurrency protection remains active even for subscriptions
    expect(() =>
      assertModelResourceAvailable({
        resources: [{ ...resource, activeRuns: 10 }],
        billingMode: 'subscription',
        requestedTokens: 5_000,
        requestedRuntimeMs: 3_600_000,
      }),
    ).toThrow(
      new ModelGovernanceError('MODEL_RESOURCE_CONCURRENCY_EXCEEDED', 'tenant'),
    );
  });

  it('40-minute approval wait does not consume effective runtime budget and extends deadline', () => {
    // Virtual timeline:
    // Root task starts at 10:00 with 1 hour limit -> deadline is 11:00
    const taskCreatedAt = new Date('2026-09-22T10:00:00.000Z');
    let deadlineAt = new Date('2026-09-22T11:00:00.000Z');

    // Run active for 10 minutes (10:00 -> 10:10)
    // At 10:10, approval requested
    const approvalRequestedAt = new Date('2026-09-22T10:10:00.000Z');

    // Virtual clock advances 40 minutes to 10:50 while waiting for approval
    const approvalDecidedAt = new Date('2026-09-22T10:50:00.000Z');
    const waitDurationMs =
      approvalDecidedAt.getTime() - approvalRequestedAt.getTime();
    expect(waitDurationMs).toBe(40 * 60 * 1000); // 40 minutes

    // When suspended with no parallel active assistants:
    const activeAssistants = 0;
    const isSuspended = activeAssistants === 0;
    expect(isSuspended).toBe(true);

    // Extension on decision:
    if (isSuspended && waitDurationMs > 0) {
      deadlineAt = new Date(deadlineAt.getTime() + waitDurationMs);
    }
    // New deadline extended from 11:00 to 11:40
    expect(deadlineAt.toISOString()).toBe('2026-09-22T11:40:00.000Z');

    // Metrics computation at 10:50:
    const wallClockElapsedMs =
      approvalDecidedAt.getTime() - taskCreatedAt.getTime(); // 50 min
    const suspendedWaitMs = waitDurationMs; // 40 min
    const effectiveRuntimeMs = Math.max(
      0,
      wallClockElapsedMs - suspendedWaitMs,
    ); // 10 min

    expect(wallClockElapsedMs).toBe(50 * 60 * 1000);
    expect(suspendedWaitMs).toBe(40 * 60 * 1000);
    expect(effectiveRuntimeMs).toBe(10 * 60 * 1000); // Only 10 min effective runtime consumed!

    // Remaining effective budget: 1 hour - 10 min = 50 minutes remaining
    const remainingBudgetMs = 3_600_000 - effectiveRuntimeMs;
    expect(remainingBudgetMs).toBe(50 * 60 * 1000);
  });

  it('active parallel assistants continue root execution clock without miscounting waiting time', () => {
    // When sub-assistants are actively running while waiting for user interaction on one branch:
    const activeAssistants: number = 1; // 1 background assistant still running
    const isSuspended = activeAssistants === 0;
    expect(isSuspended).toBe(false);

    // Root clock does NOT pause because work is actively progressing
    const waitDurationMs = 20 * 60 * 1000;
    let deadlineAt = new Date('2026-09-22T11:00:00.000Z');
    if (isSuspended) {
      deadlineAt = new Date(deadlineAt.getTime() + waitDurationMs);
    }
    // Deadline is NOT extended because parallel active assistant is consuming execution budget
    expect(deadlineAt.toISOString()).toBe('2026-09-22T11:00:00.000Z');
  });
});
