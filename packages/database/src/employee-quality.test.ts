import { describe, expect, it } from 'vitest';

import { evaluateEmployeeReleaseGate } from './employee-quality.js';

const thresholds = {
  taskSuccessRate: 0.8,
  toolSuccessRate: 0.8,
  routingAccuracy: 0.85,
  recoveryRate: 0.8,
  p95CompletionMs: 180_000,
  maxCostCents: 100,
};

const metrics = {
  taskSuccessRate: 0.95,
  toolSuccessRate: 0.9,
  routingAccuracy: 0.95,
  recoveryRate: 0.9,
  p95CompletionMs: 30_000,
  maxCostCents: 20,
  permissionDenialRate: 1,
  firstTokenP95Ms: 800,
  retryRate: 0.02,
  compactionRecoveryRate: 1,
};

describe('employee release gate', () => {
  it('passes only when every independent threshold passes', () => {
    expect(
      evaluateEmployeeReleaseGate({ thresholds, metrics, violations: [] }),
    ).toEqual({ passed: true, failures: [] });
    expect(
      evaluateEmployeeReleaseGate({
        thresholds,
        metrics: { ...metrics, routingAccuracy: 0.5 },
        violations: [],
      }),
    ).toMatchObject({ passed: false, failures: ['routing_accuracy'] });
  });

  it('always blocks a critical security or isolation violation', () => {
    expect(
      evaluateEmployeeReleaseGate({
        thresholds,
        metrics,
        violations: [
          {
            code: 'cross_tenant_access',
            severity: 'critical',
            detail: 'Tenant boundary was not preserved.',
          },
        ],
      }),
    ).toMatchObject({
      passed: false,
      failures: ['critical:cross_tenant_access'],
    });
  });
});
