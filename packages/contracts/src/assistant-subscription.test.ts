import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ResolvedModelTargetSchema,
  SessionModelSnapshotSchema,
} from './models.ts';
import {
  AssistantSubscriptionSnapshotSchema,
  resolveAssistantSubscriptionSnapshot,
} from './assistant-subscription.ts';

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
      snapshot = resolveAssistantSubscriptionSnapshot(input)!;
    expect(snapshot).toMatchObject({
      billingMode: 'subscription',
      model: input.modelSnapshot.model,
      connectionId: input.modelSnapshot.connectionId,
    });
    expect(resolveAssistantSubscriptionSnapshot(input)).toEqual(snapshot);
    for (const key of [
      'costCents',
      'currency',
      'price',
      'allowance',
      'rates',
    ]) {
      expect(snapshot).not.toHaveProperty(key);
      expect(
        AssistantSubscriptionSnapshotSchema.safeParse({ ...snapshot, [key]: 0 })
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
      resolveAssistantSubscriptionSnapshot({
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
      resolveAssistantSubscriptionSnapshot({
        ...input,
        providerSnapshot: { ...input.providerSnapshot, [key]: 'wrong' },
      }),
    ).toThrow('ASSISTANT_SUBSCRIPTION_ROUTE_UNVERIFIED');
  });
  it('does not classify legacy Gemini platform_subscription as Codex subscription', () => {
    const input = fixture();
    expect(
      resolveAssistantSubscriptionSnapshot({
        ...input,
        decision: { ...input.decision, provider: 'gemini' },
        providerSnapshot: { ...input.providerSnapshot, route: 'gemini' },
      }),
    ).toBeUndefined();
  });
  it('rejects missing frozen identity for a claimed subscription', () => {
    const input = fixture();
    expect(() =>
      resolveAssistantSubscriptionSnapshot({
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
      resolveAssistantSubscriptionSnapshot({
        ...input,
        modelSnapshot: {
          ...primary,
          fallbackPolicy: 'explicit',
          resolvedFallbacks: [target],
        },
      }),
    ).toBeDefined();
    expect(() =>
      resolveAssistantSubscriptionSnapshot({
        ...input,
        modelSnapshot: { ...primary, resolvedFallbacks: [target] },
      }),
    ).toThrow();
    expect(() =>
      resolveAssistantSubscriptionSnapshot({
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
