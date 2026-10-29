import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ResolvedModelTargetSchema,
  SessionModelSnapshotSchema,
} from './models.ts';
import {
  SubscriptionSnapshotSchema,
  resolveSubscriptionSnapshot,
} from './subscription-snapshot.ts';

function fixture() {
  const modelSnapshot = SessionModelSnapshotSchema.parse({
    schemaVersion: 1,
    sessionId: randomUUID(),
    employeeId: randomUUID(),
    policyRevision: 1,
    connectionId: randomUUID(),
    modelCatalogEntryId: randomUUID(),
    harness: 'dsh',
    provider: 'openai-codex',
    authMode: 'chatgpt_subscription',
    model: 'synthetic-codex',
    reasoningEffort: 'low',
    credentialReference: 'deployment:synthetic-not-resolved',
    baseUrl: null,
    fallbackPolicy: 'disabled',
    fallbackTargets: [],
    resolvedFallbacks: [],
    frozenAt: new Date().toISOString(),
  });
  return {
    sessionId: modelSnapshot.sessionId,
    modelSnapshot,
    decision: {
      harness: 'dsh' as const,
      provider: 'openai-codex',
      model: modelSnapshot.model,
      employeeId: modelSnapshot.employeeId,
      modelConnectionId: modelSnapshot.connectionId,
      modelCatalogEntryId: modelSnapshot.modelCatalogEntryId,
      modelPolicyRevision: 1,
    },
    providerSnapshot: {
      provider: 'dsh' as const,
      route: 'openai-codex' as const,
      authMode: 'platform_subscription' as const,
      model: modelSnapshot.model,
      reasoningEffort: 'low' as const,
      credentialReference: modelSnapshot.credentialReference!,
      baseUrl: null,
    },
  };
}

describe('trusted subscription identity, no price or credential resolution', () => {
  it('freezes a repeatable subscription identity without any currency or monetary field', () => {
    const input = fixture(),
      snapshot = resolveSubscriptionSnapshot(input)!;
    expect(snapshot).toMatchObject({
      billingMode: 'subscription',
      model: input.modelSnapshot.model,
      connectionId: input.modelSnapshot.connectionId,
    });
    expect(resolveSubscriptionSnapshot(input)).toEqual(snapshot);
    for (const key of [
      'costCents',
      'currency',
      'price',
      'allowance',
      'rates',
    ]) {
      expect(snapshot).not.toHaveProperty(key);
      expect(
        SubscriptionSnapshotSchema.safeParse({ ...snapshot, [key]: 0 })
          .success,
      ).toBe(false);
    }
  });
  it.each([
    'sessionId',
    'employeeId',
    'connectionId',
    'modelCatalogEntryId',
    'policyRevision',
    'authMode',
    'model',
    'credentialReference',
    'baseUrl',
    'harness',
  ])('rejects altered frozen %s', (key) => {
    const input = fixture();
    const value =
      key === 'policyRevision'
        ? 2
        : key === 'authMode'
          ? 'api_key'
          : key === 'baseUrl'
            ? 'https://example.test/v1'
            : key === 'harness'
              ? 'codex'
              : randomUUID();
    expect(() =>
      resolveSubscriptionSnapshot({
        ...input,
        modelSnapshot: { ...input.modelSnapshot, [key]: value },
      }),
    ).toThrow('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
  });
  it.each([
    'authMode',
    'model',
    'credentialReference',
    'baseUrl',
    'reasoningEffort',
  ])('rejects altered runtime %s', (key) => {
    const input = fixture();
    expect(() =>
      resolveSubscriptionSnapshot({
        ...input,
        providerSnapshot: { ...input.providerSnapshot, [key]: 'wrong' },
      }),
    ).toThrow('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
  });
  it('rejects missing frozen identity for a claimed subscription', () => {
    const input = fixture();
    expect(() =>
      resolveSubscriptionSnapshot({
        ...input,
        modelSnapshot: undefined,
      }),
    ).toThrow('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
  });
  it('accepts only a unique explicit frozen fallback, not an implicit or duplicated target', () => {
    const input = fixture();
    const target = ResolvedModelTargetSchema.strip().parse(input.modelSnapshot);
    const primary = {
      ...input.modelSnapshot,
      connectionId: randomUUID(),
      modelCatalogEntryId: randomUUID(),
    };
    expect(
      resolveSubscriptionSnapshot({
        ...input,
        modelSnapshot: {
          ...primary,
          fallbackPolicy: 'explicit',
          resolvedFallbacks: [target],
        },
      }),
    ).toBeDefined();
    expect(() =>
      resolveSubscriptionSnapshot({
        ...input,
        modelSnapshot: { ...primary, resolvedFallbacks: [target] },
      }),
    ).toThrow();
    expect(() =>
      resolveSubscriptionSnapshot({
        ...input,
        modelSnapshot: {
          ...primary,
          fallbackPolicy: 'explicit',
          resolvedFallbacks: [target, target],
        },
      }),
    ).toThrow();
  });
});
