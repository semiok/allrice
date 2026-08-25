import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EmployeeDefinitionSchema,
  EmployeeExecutionSnapshotSchema,
  EmployeeManifestSchema,
  PublishEmployeeVersionInputSchema,
} from './employees.js';

describe('EmployeeHub contracts', () => {
  it('accepts a Codex-backed Rice manifest with exact SkillVersion IDs', () => {
    const skillVersionId = randomUUID();
    const manifest = EmployeeManifestSchema.parse({
      schemaVersion: 1,
      key: 'default-assistant',
      name: 'Rice',
      description: 'General AI employee',
      systemPrompt: 'Act as Rice inside the authorized tenant context.',
      provider: {
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
      },
      capabilities: ['model:invoke'],
      skillVersionIds: [skillVersionId],
    });
    expect(manifest.name).toBe('Rice');
    expect(manifest.provider.provider).toBe('codex');
    expect(manifest.skillVersionIds).toEqual([skillVersionId]);
    expect(manifest.partnerProfile.role).toBe('通用工作伙伴');
    expect(manifest.partnerProfile.approvalPolicy).toBe('confirm_side_effects');
  });

  it('accepts a DSH provider snapshot without storing the API key', () => {
    const definition = EmployeeDefinitionSchema.parse({
      schemaVersion: 2,
      key: 'research-partner',
      name: '研究伙伴',
      description: '使用受限 DSH runtime 完成研究工作。',
      appearance: { avatarType: 'emoji', avatarValue: '🔎' },
      applicableScenarios: ['公开资料研究'],
      isDefaultRice: false,
      identity: {
        role: '研究伙伴',
        mission: '核实资料并形成结论。',
        workStyle: '先核实来源，再给出判断。',
        behaviorRules: ['区分事实与推断。'],
        safetyBoundaries: ['只使用已授权工具。'],
      },
      systemPrompt: 'Work only through the AllRice Tool Broker.',
      provider: {
        provider: 'dsh',
        authMode: 'allrice_credential',
        route: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
        credentialReference: 'deployment:deepseek-default',
        baseUrl: null,
      },
      runtimePolicy: {
        harness: 'dsh',
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'high',
        timeoutMs: 300_000,
        fallbackModels: [],
        credentialReference: 'deployment:deepseek-default',
        baseUrl: null,
      },
      capabilities: ['model:invoke'],
      skillVersionIds: [],
      capabilityBindings: {
        skillVersionIds: [],
        toolNames: [],
        knowledgeScopes: ['workspace', 'user'],
        workflowIds: [],
      },
      securityPolicy: {
        dataScopes: ['workspace', 'user'],
        connectorIdentityModes: ['user'],
        approvalPolicy: 'confirm_side_effects',
        deniedCapabilities: ['secret:use'],
      },
      partnerProfile: {
        role: '研究伙伴',
        mission: '核实资料并形成结论。',
        communicationStyle: 'structured',
        outputLanguage: 'zh-CN',
        proactivePolicy: 'suggest',
        approvalPolicy: 'confirm_side_effects',
      },
    });
    expect(definition.provider).toMatchObject({
      provider: 'dsh',
      route: 'deepseek-official',
      credentialReference: 'deployment:deepseek-default',
    });
    expect(JSON.stringify(definition)).not.toContain('apiKey');
  });

  it('rejects mutable skill aliases in a publication request', () => {
    expect(() =>
      PublishEmployeeVersionInputSchema.parse({
        workspaceId: randomUUID(),
        employeeId: randomUUID(),
        skillVersionIds: ['weather@latest'],
      }),
    ).toThrow();
  });

  it('accepts a persisted partner profile in a publication request', () => {
    const parsed = PublishEmployeeVersionInputSchema.parse({
      workspaceId: randomUUID(),
      employeeId: randomUUID(),
      skillVersionIds: [],
      partnerProfile: {
        role: '客户成功伙伴',
        mission: '跟进客户问题并维护交付节奏。',
        communicationStyle: 'structured',
        outputLanguage: 'zh-CN',
        proactivePolicy: 'suggest',
        approvalPolicy: 'confirm_external',
      },
    });
    expect(parsed.partnerProfile?.role).toBe('客户成功伙伴');
    expect(parsed.partnerProfile?.approvalPolicy).toBe('confirm_external');
  });

  it('accepts an admin configuration update without requiring Skill IDs', () => {
    const parsed = PublishEmployeeVersionInputSchema.parse({
      workspaceId: randomUUID(),
      employeeId: randomUUID(),
      identity: {
        role: '研究伙伴',
        mission: '核实资料并形成结论。',
        workStyle: '先核实来源，再区分事实和判断。',
        behaviorRules: ['引用来源。'],
        safetyBoundaries: ['不访问其他租户数据。'],
      },
      userProfilePolicy: {
        enabled: true,
        fields: ['preferences'],
        scope: 'employee_user',
      },
      toolNames: ['workspace.file.read'],
    });
    expect(parsed.skillVersionIds).toBeUndefined();
    expect(parsed.identity?.role).toBe('研究伙伴');
    expect(parsed.userProfilePolicy?.fields).toEqual(['preferences']);
  });

  it('validates a complete Employee Definition and exact capability bindings', () => {
    const skillVersionId = randomUUID();
    const definition = EmployeeDefinitionSchema.parse({
      schemaVersion: 2,
      key: 'contract-reviewer',
      name: '合同审查员',
      description: '审查合同风险并输出修改建议。',
      appearance: { avatarType: 'emoji', avatarValue: '📄' },
      applicableScenarios: ['合同审查'],
      isDefaultRice: false,
      identity: {
        role: '合同审查员',
        mission: '识别风险并给出可执行修改建议。',
        workStyle: '先说明风险，再给出修改建议。',
        behaviorRules: ['区分事实、判断和建议。'],
        safetyBoundaries: ['不替代律师作最终法律判断。'],
      },
      systemPrompt: 'Work only inside the authorized tenant context.',
      provider: {
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
      },
      runtimePolicy: {
        harness: 'codex',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        timeoutMs: 300_000,
        fallbackModels: [],
      },
      capabilities: ['model:invoke', 'storage:read'],
      skillVersionIds: [skillVersionId],
      capabilityBindings: {
        skillVersionIds: [skillVersionId],
        toolNames: ['workspace.file.read'],
        knowledgeScopes: ['workspace', 'user'],
        workflowIds: [],
      },
      securityPolicy: {
        dataScopes: ['workspace', 'user'],
        connectorIdentityModes: ['user'],
        approvalPolicy: 'confirm_side_effects',
        deniedCapabilities: ['secret:use'],
      },
      partnerProfile: {
        role: '合同审查员',
        mission: '识别风险并给出可执行修改建议。',
        communicationStyle: 'structured',
        outputLanguage: 'zh-CN',
        proactivePolicy: 'suggest',
        approvalPolicy: 'confirm_side_effects',
      },
    });
    expect(definition.schemaVersion).toBe(2);
    expect(definition.capabilityBindings.skillVersionIds).toEqual([
      skillVersionId,
    ]);
    expect(definition.userProfilePolicy).toEqual({
      enabled: true,
      fields: ['displayName', 'preferences'],
      scope: 'employee_user',
    });
    expect(() =>
      EmployeeDefinitionSchema.parse({
        ...definition,
        capabilityBindings: {
          ...definition.capabilityBindings,
          skillVersionIds: [],
        },
      }),
    ).toThrow('skill bindings must match skillVersionIds');
  });

  it('freezes employee, assignment, tenant and capability context for a run', () => {
    const employeeId = randomUUID();
    const versionId = randomUUID();
    const assignmentId = randomUUID();
    const userId = randomUUID();
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const policySnapshotId = randomUUID();
    const definition = EmployeeManifestSchema.parse({
      schemaVersion: 1,
      key: 'default-assistant',
      name: 'Rice',
      description: 'General AI employee',
      systemPrompt: 'Act as Rice inside the authorized tenant context.',
      provider: {
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
      },
      capabilities: ['model:invoke'],
      skillVersionIds: [],
    });
    const snapshot = EmployeeExecutionSnapshotSchema.parse({
      schemaVersion: 1,
      employee: {
        id: employeeId,
        key: definition.key,
        versionId,
        revision: 1,
        definitionChecksum: `sha256:${'a'.repeat(64)}`,
        definition,
      },
      assignment: {
        id: assignmentId,
        userId,
        assignedBy: userId,
        assignedAt: '2026-08-25T00:00:00.000Z',
      },
      runtimePolicy: {
        harness: 'codex',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        timeoutMs: 300_000,
        fallbackModels: [],
      },
      capabilitySnapshot: {
        declaredCapabilities: ['model:invoke'],
        grantedCapabilities: ['model:invoke'],
        bindings: {
          skillVersionIds: [],
          toolNames: [],
          knowledgeScopes: ['workspace', 'user'],
          workflowIds: [],
        },
        skillBindings: [],
      },
      tenantContext: {
        organizationId,
        workspaceId,
        actorId: userId,
        policySnapshotId,
      },
      userProfile: {
        schemaVersion: 1,
        displayName: '测试用户',
        preferences: {},
      },
      createdAt: '2026-08-25T00:00:01.000Z',
    });
    expect(snapshot.employee.definition).toEqual(definition);
    expect(snapshot.tenantContext).toMatchObject({
      organizationId,
      workspaceId,
      actorId: userId,
      policySnapshotId,
    });
  });

  it('freezes three independent capability families in a v2 run snapshot', () => {
    const employeeId = randomUUID();
    const versionId = randomUUID();
    const assignmentId = randomUUID();
    const userId = randomUUID();
    const organizationId = randomUUID();
    const workspaceId = randomUUID();
    const definition = EmployeeManifestSchema.parse({
      schemaVersion: 1,
      key: 'default-assistant',
      name: 'Rice',
      description: 'General AI employee',
      systemPrompt: 'Act only inside the frozen capability snapshot.',
      provider: {
        provider: 'codex',
        authMode: 'chatgpt_subscription',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        sandbox: 'workspace-write',
      },
      capabilities: ['model:invoke'],
      skillVersionIds: [],
    });
    const snapshot = EmployeeExecutionSnapshotSchema.parse({
      schemaVersion: 2,
      employee: {
        id: employeeId,
        key: definition.key,
        versionId,
        revision: 1,
        definitionChecksum: `sha256:${'a'.repeat(64)}`,
        definition,
      },
      assignment: {
        id: assignmentId,
        userId,
        assignedBy: userId,
        assignedAt: '2026-08-25T00:00:00.000Z',
      },
      runtimePolicy: {
        harness: 'codex',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        timeoutMs: 300_000,
        fallbackModels: [],
      },
      capabilitySnapshot: {
        declaredCapabilities: ['model:invoke'],
        grantedCapabilities: ['model:invoke'],
        bindings: {
          skillVersionIds: [],
          toolNames: [],
          knowledgeScopes: [],
          workflowIds: [],
        },
        skillBindings: [],
        agentSkills: [],
        workflows: [],
        knowledge: [],
        resolvedForActorId: userId,
      },
      tenantContext: {
        organizationId,
        workspaceId,
        actorId: userId,
        policySnapshotId: randomUUID(),
      },
      userProfile: {
        schemaVersion: 1,
        displayName: '测试用户',
        preferences: {},
      },
      createdAt: '2026-08-25T00:00:01.000Z',
    });
    expect(snapshot.schemaVersion).toBe(2);
    if (snapshot.schemaVersion === 2) {
      expect(snapshot.capabilitySnapshot.resolvedForActorId).toBe(userId);
      expect(snapshot.capabilitySnapshot.workflows).toEqual([]);
      expect(snapshot.capabilitySnapshot.knowledge).toEqual([]);
    }
  });
});
