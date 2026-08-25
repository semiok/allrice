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
});
