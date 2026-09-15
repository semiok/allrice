import { describe, expect, it } from 'vitest';
import type { Employee, Workspace } from './chatflow-types';
import {
  assistantEligibility,
  assistantPreferenceForTask,
} from './assistant-eligibility';

const employee = (
  provider?: string,
  tools = ['assistant.delegate'],
): Pick<Employee, 'currentVersion'> => ({
  currentVersion: {
    id: 'current',
    manifest: {
      name: 'Rice',
      runtimePolicy: { harness: 'dsh', provider },
      capabilityBindings: { toolNames: tools },
    },
  },
});
const frozen = (
  provider: string,
  sessionId = 'active',
): Workspace['sessionModels'] => [
  {
    sessionId,
    harness: 'dsh',
    provider,
    model: 'synthetic',
    reasoningEffort: 'low',
  },
];
const eligibility = (
  provider: string | undefined,
  models: Workspace['sessionModels'] = [],
  sessionId: string | null = 'active',
) =>
  assistantEligibility({
    enabled: true,
    sessionId,
    sessionModels: models,
    employee: employee(provider),
  });

describe('P26 assistant availability follows the server Session model (display only)', () => {
  it.each(['gemini', 'unknown'])(
    'keeps frozen subscription Codex available after the current default changes to %s',
    (provider) => {
      expect(eligibility(provider, frozen('openai-codex'))).toEqual({
        eligible: true,
        unavailableReason: null,
      });
    },
  );
  it('keeps frozen Gemini available even after the current default changes to Codex', () => {
    expect(eligibility('openai-codex', frozen('gemini')).eligible).toBe(true);
  });
  it('does not replace an unknown frozen provider with a supported default', () => {
    expect(eligibility('gemini', frozen('unknown')).eligible).toBe(false);
    expect(eligibility('gemini', frozen('')).eligible).toBe(false);
    expect(eligibility('openai-codex', frozen('codex')).eligible).toBe(false);
    expect(eligibility('openai-codex', frozen('unknown')).eligible).toBe(false);
  });
  it.each(['gemini', 'google', 'openai-compatible', 'openai-codex'])(
    'offers only the verified display protocol %s',
    (provider) => {
      expect(eligibility('unknown', frozen(provider)).eligible).toBe(true);
      expect(eligibility(provider, [], null).eligible).toBe(true);
    },
  );
  it.each([
    'codex',
    'OpenAI-Codex',
    ' openai-codex',
    'openai-codex ',
    'deepseek',
    'deepseek-official',
    'unknown',
    '',
    'Gemini',
    undefined,
  ])(
    'keeps an unfrozen unsupported or unknown default unavailable: %s',
    (provider) => {
      expect(eligibility(provider, [], null)).toEqual({
        eligible: false,
        unavailableReason: 'model_unsupported',
      });
    },
  );
  it('uses the employee default only when this Session has no frozen model', () => {
    expect(
      eligibility('gemini', frozen('openai-codex', 'other')).eligible,
    ).toBe(true);
    expect(
      eligibility('openai-codex', frozen('gemini', 'other')).eligible,
    ).toBe(true);
    expect(
      eligibility('unknown', frozen('openai-codex', 'other')).eligible,
    ).toBe(false);
  });
  it.each(['gemini', 'openai-codex'])(
    '%s still requires the rollout flag and employee delegation tool',
    (provider) => {
      expect(
        assistantEligibility({
          enabled: false,
          sessionId: 'active',
          sessionModels: frozen(provider),
          employee: employee(provider),
        }),
      ).toEqual({ eligible: false, unavailableReason: 'feature_disabled' });
      expect(
        assistantEligibility({
          enabled: true,
          sessionId: 'active',
          sessionModels: frozen(provider),
          employee: employee(provider, []),
        }),
      ).toEqual({ eligible: false, unavailableReason: 'employee_not_enabled' });
      expect(
        assistantEligibility({
          enabled: true,
          sessionId: 'active',
          sessionModels: frozen(provider),
        }).eligible,
      ).toBe(false);
    },
  );
});

describe('P26 submitted next-task assistant preference', () => {
  it('allows subscription Codex preference without changing the frozen model', () => {
    const snapshot = frozen('openai-codex');
    const before = JSON.stringify(snapshot);
    const available = eligibility('gemini', snapshot);
    const preference = assistantPreferenceForTask({
      enabled: true,
      deliveryMode: 'follow_up',
      eligible: available.eligible,
      allowAssistants: true,
    });
    expect(preference).toEqual({ mode: 'daily', allowAssistants: true });
    expect(JSON.stringify(snapshot)).toBe(before);
  });
  it.each([
    ['gemini', true],
    ['gemini', false],
    ['openai-codex', true],
    ['openai-codex', false],
  ] as const)(
    'preserves the %s user preference %s, including explicit opt-out',
    (provider, allowAssistants) => {
      expect(
        assistantPreferenceForTask({
          enabled: true,
          deliveryMode: 'follow_up',
          eligible: eligibility('unknown', frozen(provider)).eligible,
          allowAssistants,
        }),
      ).toEqual({ mode: 'daily', allowAssistants });
    },
  );
  it('clamps allow=true for an unknown frozen model despite a Codex default', () => {
    expect(
      assistantPreferenceForTask({
        enabled: true,
        deliveryMode: 'follow_up',
        eligible: eligibility('openai-codex', frozen('unknown')).eligible,
        allowAssistants: true,
      }),
    ).toEqual({ mode: 'daily', allowAssistants: false });
  });
  it('does not reuse a supported model preference after switching to an unsupported model', () => {
    for (const provider of ['codex', 'deepseek-official', 'unknown']) {
      expect(
        assistantPreferenceForTask({
          enabled: true,
          deliveryMode: 'follow_up',
          eligible: eligibility(provider).eligible,
          allowAssistants: true,
        })?.allowAssistants,
      ).toBe(false);
    }
  });
  it.each(['steer', 'auto'])(
    'does not attach next-task preference to %s',
    (deliveryMode) => {
      expect(
        assistantPreferenceForTask({
          enabled: true,
          deliveryMode,
          eligible: true,
          allowAssistants: true,
        }),
      ).toBeUndefined();
    },
  );
  it('omits the preference when the rollout flag is disabled', () => {
    expect(
      assistantPreferenceForTask({
        enabled: false,
        deliveryMode: 'follow_up',
        eligible: true,
        allowAssistants: true,
      }),
    ).toBeUndefined();
  });
});
