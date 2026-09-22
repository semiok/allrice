import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EmployeeModelPolicySchema,
  ModelCatalogEntrySchema,
  ModelConnectionSchema,
  SessionModelSnapshotSchema,
} from './models.ts';

describe('platform model pool contracts', () => {
  it('accepts the managed Codex default with xhigh reasoning', () => {
    const now = new Date().toISOString();
    const connectionId = randomUUID();
    const modelCatalogEntryId = randomUUID();
    const employeeId = randomUUID();
    const policy = EmployeeModelPolicySchema.parse({
      schemaVersion: 1,
      employeeId,
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
      connectionId,
      modelCatalogEntryId,
      reasoningEffort: 'xhigh',
      fallbackPolicy: 'disabled',
      fallbackTargets: [],
      revision: 1,
      updatedBy: randomUUID(),
      updatedAt: now,
    });
    expect(policy.reasoningEffort).toBe('xhigh');
    expect(policy.runLimits).toEqual({
      timeoutMs: 3_600_000,
      maxInputTokens: 120_000,
      maxOutputTokens: 16_000,
      maxTotalTokens: 136_000,
      maxCostCents: null,
    });
    expect(policy.fallbackOn).toContain('provider_unavailable');
    expect(
      SessionModelSnapshotSchema.parse({
        schemaVersion: 1,
        sessionId: randomUUID(),
        employeeId,
        policyRevision: 1,
        connectionId,
        modelCatalogEntryId,
        harness: 'codex',
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'xhigh',
        credentialReference: 'deployment:codex-default',
        baseUrl: null,
        fallbackPolicy: 'disabled',
        fallbackTargets: [],
        frozenAt: now,
      }).model,
    ).toBe('gpt-5.6-luna');
  });

  it('rejects cross-scope connections and unsupported catalog defaults', () => {
    const now = new Date().toISOString();
    expect(() =>
      ModelConnectionSchema.parse({
        id: randomUUID(),
        providerId: randomUUID(),
        organizationId: randomUUID(),
        scope: 'platform',
        name: 'invalid',
        credentialReference: null,
        baseUrl: null,
        status: 'ready',
        stability: 'production',
        priority: 100,
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
    expect(() =>
      ModelCatalogEntrySchema.parse({
        id: randomUUID(),
        providerId: randomUUID(),
        model: 'model',
        displayName: 'Model',
        contextWindowTokens: null,
        reasoningEfforts: ['low'],
        defaultReasoningEffort: 'xhigh',
        inputModalities: ['text'],
        outputModalities: ['text'],
        enabled: true,
        stability: 'production',
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow();
  });

  it('requires an explicit fallback target when fallback is enabled', () => {
    expect(() =>
      EmployeeModelPolicySchema.parse({
        schemaVersion: 1,
        employeeId: randomUUID(),
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        connectionId: randomUUID(),
        modelCatalogEntryId: randomUUID(),
        reasoningEffort: 'high',
        fallbackPolicy: 'explicit',
        fallbackTargets: [],
        revision: 1,
        updatedBy: randomUUID(),
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it('rejects a total token budget below an individual boundary', () => {
    expect(() =>
      EmployeeModelPolicySchema.parse({
        schemaVersion: 1,
        employeeId: randomUUID(),
        organizationId: randomUUID(),
        workspaceId: randomUUID(),
        connectionId: randomUUID(),
        modelCatalogEntryId: randomUUID(),
        reasoningEffort: 'high',
        fallbackPolicy: 'disabled',
        fallbackTargets: [],
        runLimits: {
          timeoutMs: 60_000,
          maxInputTokens: 20_000,
          maxOutputTokens: 4_000,
          maxTotalTokens: 10_000,
          maxCostCents: 25,
        },
        revision: 1,
        updatedBy: randomUUID(),
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow(/total token limit/);
  });
});
