import { describe, expect, it } from 'vitest';

import {
  PlatformEmployeeDefinitionSchema,
  PlatformEmployeeRuntimeProfileSchema,
  PlatformEmployeeTestRunSchema,
} from './platform-employees.ts';

const riceDefinition = {
  schemaVersion: 1 as const,
  key: 'rice',
  name: 'Rice',
  description: 'AllRice 默认通用 AI 员工。',
  appearance: { avatarType: 'initials' as const, avatarValue: 'R' },
  identity: {
    role: '通用工作伙伴',
    mission: '理解目标并推进工作。',
    workStyle: '结论优先，结构化推进。',
    behaviorRules: ['不编造执行结果。'],
    safetyBoundaries: ['只使用已授权数据。'],
    expressionStyle: 'structured' as const,
    outputLanguage: 'zh-CN' as const,
  },
  systemPrompt: 'You are Rice in AllRice.',
  modelPolicy: {
    provider: 'openai-codex' as const,
    model: 'gpt-5.6-luna',
    reasoningEffort: 'xhigh' as const,
    timeoutMs: 300_000,
    fallbackModels: [],
    credentialReference: 'deployment:codex-default',
    baseUrl: null,
  },
  capabilities: {
    nativeSkillIds: [],
    workflowRevisionIds: [],
    knowledgeRevisionIds: [],
    toolNames: ['web.search'],
    connectorRefs: [],
  },
  securityPolicy: {
    dataScopes: ['workspace', 'employee', 'user'] as const,
    approvalPolicy: 'confirm_side_effects' as const,
    bridgeAccess: 'read_only' as const,
    connectorIdentityModes: ['user'] as const,
    deniedCapabilities: ['secret:use'] as const,
  },
};

describe('platform employee production contract', () => {
  it('accepts a platform-owned Rice definition', () => {
    expect(PlatformEmployeeDefinitionSchema.parse(riceDefinition).key).toBe(
      'rice',
    );
  });

  it('requires DSH as the compiled Harness', () => {
    const profile = PlatformEmployeeRuntimeProfileSchema.parse({
      schemaVersion: 1,
      harness: 'dsh',
      employeeKey: 'rice',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'xhigh',
      timeoutMs: 300_000,
      credentialReference: 'deployment:codex-default',
      systemPrompt: riceDefinition.systemPrompt,
      nativeSkillIds: [],
      nativeSkillChecksums: [],
      toolNames: ['web.search'],
      connectorRefs: [],
      securityPolicy: riceDefinition.securityPolicy,
    });
    expect(profile.harness).toBe('dsh');
    expect(profile.baseUrl).toBeNull();
  });

  it('accepts a durable isolated DSH test result', () => {
    const now = new Date().toISOString();
    const testRun = PlatformEmployeeTestRunSchema.parse({
      id: '10000000-0000-4000-8000-000000000001',
      employeeId: '10000000-0000-4000-8000-000000000002',
      revisionId: '10000000-0000-4000-8000-000000000003',
      status: 'succeeded',
      input: { prompt: '介绍你的职责。' },
      output: {
        answer: '我是 Rice。',
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        threadId: 'dsh-isolated-test',
        usage: {
          inputTokens: 20,
          cachedInputTokens: 0,
          outputTokens: 8,
        },
        events: [],
        error: null,
      },
      createdAt: now,
      startedAt: now,
      completedAt: now,
    });
    expect(testRun.output?.answer).toBe('我是 Rice。');
  });
});
