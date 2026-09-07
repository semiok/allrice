import { describe, expect, it } from 'vitest';
import {
  EMPLOYEE_PROVIDER_OPTIONS,
  employeeModelPolicyProblem,
  employeeReasoningSettings,
  switchEmployeeModelProvider,
} from './employee-model-settings.ts';
import {
  PlatformEmployeeDefinitionSchema,
  UpdatePlatformEmployeeInputSchema,
} from './platform-employees.ts';

const policy = {
  provider: 'openai-codex' as const,
  model: 'gpt-5.6-luna',
  reasoningEffort: 'xhigh' as const,
  timeoutMs: 300_000,
  fallbackModels: ['old-provider-model'],
  credentialReference: 'deployment:codex-default',
  baseUrl: 'https://old.example/v1',
};

describe('employee provider-specific configuration', () => {
  it('only offers the two requested providers for new configuration', () => {
    expect(EMPLOYEE_PROVIDER_OPTIONS.map((item) => item.value)).toEqual([
      'openai-codex',
      'gemini',
    ]);
  });
  it('distinguishes Codex from Gemini Flash and legacy Pro', () => {
    expect(
      employeeReasoningSettings('openai-codex', 'gpt-5.5-mini').efforts,
    ).toEqual([]);
    expect(
      employeeReasoningSettings('openai-codex', 'gpt-5.6-luna').efforts,
    ).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(
      employeeReasoningSettings('gemini', 'gemini-3.8-flash').efforts,
    ).toEqual(['low', 'medium', 'high']);
    expect(employeeReasoningSettings('gemini', '3.8flash').efforts).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(
      employeeReasoningSettings('gemini', 'gemini-3-pro-preview').efforts,
    ).toEqual(['low', 'high']);
    expect(
      employeeReasoningSettings('gemini', 'gemini-3.1-pro-preview').efforts,
    ).toEqual(['low', 'high']);
    expect(
      employeeReasoningSettings('gemini', 'unverified-model').efforts,
    ).toEqual([]);
  });
  it('resets incompatible effort, credential, URL and fallback only on an explicit provider switch', () => {
    const next = switchEmployeeModelProvider(policy, 'gemini');
    expect(next).toMatchObject({
      model: 'gemini-3.8-flash',
      reasoningEffort: 'medium',
      credentialReference: 'deployment:gemini-default',
      baseUrl: null,
      fallbackModels: [],
    });
    expect(policy.reasoningEffort).toBe('xhigh');
    expect(switchEmployeeModelProvider(policy, 'openai-codex')).toBe(policy);
    expect(switchEmployeeModelProvider(next, 'openai-codex')).toMatchObject({
      model: 'gpt-5.6-luna',
      credentialReference: 'deployment:codex-default',
      reasoningEffort: 'medium',
    });
    expect(
      switchEmployeeModelProvider(
        { ...policy, reasoningEffort: 'high' },
        'gemini',
      ).reasoningEffort,
    ).toBe('high');
  });
  it.each(['none', 'xhigh'] as const)(
    'rejects Gemini %s while preserving the readable historical schema',
    (effort) => {
      const invalid = {
        ...policy,
        provider: 'gemini' as const,
        model: '3.8flash',
        reasoningEffort: effort,
      };
      expect(
        PlatformEmployeeDefinitionSchema.shape.modelPolicy.safeParse(invalid)
          .success,
      ).toBe(true);
      expect(employeeModelPolicyProblem(invalid)).toContain('当前模型不支持');
    },
  );
  it('rejects removed providers without removing their historical enum values', () => {
    for (const provider of [
      'deepseek-official',
      'openai-compatible',
    ] as const) {
      const removed = { ...policy, provider };
      expect(
        PlatformEmployeeDefinitionSchema.shape.modelPolicy.safeParse(removed)
          .success,
      ).toBe(true);
      expect(employeeModelPolicyProblem(removed)).toContain(
        '已从新配置入口移除',
      );
    }
  });
  it('runs model validation in the new draft write schema, not the historical read schema', () => {
    const definition = {
      schemaVersion: 1,
      key: 'test',
      name: 'Test',
      description: 'Synthetic',
      appearance: { avatarType: 'initials', avatarValue: 'T' },
      identity: {
        role: 'Test',
        mission: 'Test',
        workStyle: 'Test',
        behaviorRules: [],
        safetyBoundaries: [],
        expressionStyle: 'concise',
        outputLanguage: 'zh-CN',
      },
      systemPrompt: 'Synthetic',
      modelPolicy: { ...policy, provider: 'gemini', model: 'gemini-3.8-flash' },
      capabilities: {
        nativeSkillIds: [],
        workflowRevisionIds: [],
        knowledgeRevisionIds: [],
        toolNames: [],
        connectorRefs: [],
      },
      securityPolicy: {
        dataScopes: [],
        approvalPolicy: 'confirm_external',
        bridgeAccess: 'none',
        connectorIdentityModes: [],
        deniedCapabilities: [],
      },
    };
    expect(PlatformEmployeeDefinitionSchema.safeParse(definition).success).toBe(
      true,
    );
    expect(
      UpdatePlatformEmployeeInputSchema.safeParse({ definition }).success,
    ).toBe(false);
    definition.modelPolicy.reasoningEffort =
      'medium' as typeof policy.reasoningEffort;
    expect(
      UpdatePlatformEmployeeInputSchema.safeParse({ definition }).success,
    ).toBe(true);
  });
});
