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
  it('offers only Codex and keeps Gemini readable but invalid for new selection', () => {
    expect(EMPLOYEE_PROVIDER_OPTIONS.map((item) => item.value)).toEqual([
      'openai-codex',
    ]);
    expect(
      employeeReasoningSettings('openai-codex', 'gpt-5.6-luna').efforts,
    ).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(
      employeeReasoningSettings('gemini', 'gemini-3.8-flash').efforts,
    ).toEqual([]);
    const old = {
      ...policy,
      provider: 'gemini' as const,
      model: 'gemini-3.8-flash',
    };
    expect(
      PlatformEmployeeDefinitionSchema.shape.modelPolicy.safeParse(old).success,
    ).toBe(true);
    expect(employeeModelPolicyProblem(old)).toContain('已从新配置入口移除');
    expect(switchEmployeeModelProvider(old, 'openai-codex')).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-6-luna',
      credentialReference: 'deployment:codex-default',
      baseUrl: null,
      fallbackModels: [],
    });
  });
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
    ).toBe(false);
  });
});
