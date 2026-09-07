import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ModelProviderSchema,
  modelProviderRuntimeSupported,
} from './models.ts';
import { DshExecutionSnapshotSchema } from './skills.ts';
import { EmployeeProviderSnapshotSchema } from './employees.ts';
import {
  ProviderAuthorizationFlowSchema,
  ProviderGrantSchema,
} from './provider-auth.ts';

describe('Gemini historical records do not imply OAuth authority', () => {
  const snapshot = {
    provider: 'dsh',
    route: 'gemini',
    authMode: 'platform_subscription',
    model: '3.8flash',
    reasoningEffort: 'medium',
    credentialReference: 'deployment:gemini-default',
    baseUrl: null,
  };
  it('preserves historical snapshots and accepts correctly described new API credentials', () => {
    expect(EmployeeProviderSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      DshExecutionSnapshotSchema.parse({
        ...snapshot,
        authMode: 'allrice_credential',
      }).authMode,
    ).toBe('allrice_credential');
  });
  it('retains Codex subscription and strict unknown route checks', () => {
    expect(
      DshExecutionSnapshotSchema.safeParse({
        ...snapshot,
        route: 'openai-codex',
      }).success,
    ).toBe(true);
    expect(
      DshExecutionSnapshotSchema.safeParse({
        ...snapshot,
        route: 'openai-codex',
        authMode: 'allrice_credential',
      }).success,
    ).toBe(false);
    expect(
      DshExecutionSnapshotSchema.safeParse({ ...snapshot, route: 'zhipu' })
        .success,
    ).toBe(false);
    expect(
      DshExecutionSnapshotSchema.safeParse({
        ...snapshot,
        apiKey: 'must-not-be-stored',
      }).success,
    ).toBe(false);
  });
  it('reads the legacy Zhipu/OAuth catalog without renaming or claiming executable support', () => {
    const provider = ModelProviderSchema.parse({
      id: randomUUID(),
      key: 'zhipu',
      name: 'Synthetic legacy provider',
      harness: 'dsh',
      authMode: 'gemini_oauth',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(provider.key).toBe('zhipu');
    expect(modelProviderRuntimeSupported(provider)).toBe(false);
    expect(
      modelProviderRuntimeSupported({ key: 'gemini', authMode: 'oauth' }),
    ).toBe(false);
    expect(
      modelProviderRuntimeSupported({ key: 'gemini', authMode: 'api_key' }),
    ).toBe(true);
    expect(
      modelProviderRuntimeSupported({
        key: 'codex',
        authMode: 'chatgpt_subscription',
      }),
    ).toBe(true);
  });
  it('does not broaden the existing Codex-only authorization contracts', () => {
    expect(
      ProviderAuthorizationFlowSchema.shape.provider.safeParse('gemini')
        .success,
    ).toBe(false);
    expect(
      ProviderGrantSchema.shape.authMode.safeParse('gemini_oauth').success,
    ).toBe(false);
  });
});
