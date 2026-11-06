import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EmployeeDefinitionSchema,
  EmployeeExecutionSnapshotSchema,
  EmployeeManifestSchema,
  EmployeeInstanceProfileSchema,
  EmployeeRuntimePackageSchema,
  PublishEmployeeVersionInputSchema,
} from './employees.js';

describe('runtime package PERSONA source format', () => {
  const foundation = {
    name: 'Rice',
    description: 'Synthetic platform source',
    appearance: { avatarType: 'initials', avatarValue: 'R' },
    identity: {
      role: 'Research partner',
      mission: 'Check the original evidence',
      workStyle: 'Explain the result',
      behaviorRules: ['Do not invent results'],
      safetyBoundaries: ['Use authorized data only'],
      expressionStyle: 'structured',
      outputLanguage: 'zh-CN',
    },
  };
  const package3 = {
    schemaVersion: 3,
    packageVersion: 'rice:r1',
    checksum: `sha256:${'a'.repeat(64)}`,
    capabilityFingerprint: `sha256:${'b'.repeat(64)}`,
    foundation,
    platformPolicy: 'Platform-owned policy remains separate.',
    skills: [],
    runtimeManifest: {
      source: 'allrice-published-runtime',
      harness: 'dsh',
      distributionGeneration: 'synthetic-generation',
      provider: 'openai-codex',
      model: 'synthetic',
      toolNames: [],
      deniedCapabilities: [],
      skillGovernance: [],
    },
  };

  it('reads complete platform identity and hard-policy sources without legacy files or personal data', () => {
    const before = JSON.stringify(package3);
    expect(EmployeeRuntimePackageSchema.parse(package3)).toEqual(package3);
    expect(JSON.stringify(package3)).toBe(before);
    for (const extra of [
      { files: { agentsMd: '', identityMd: '', soulMd: '', userMd: '' } },
      { persona: '# PERSONA.md' },
      { profile: {} },
      { user: '# USER.md' },
      { memory: '# MEMORY.md' },
      {
        runtimeManifest: {
          ...package3.runtimeManifest,
          instructionPrecedence: [],
        },
      },
    ]) {
      expect(
        EmployeeRuntimePackageSchema.safeParse({ ...package3, ...extra })
          .success,
      ).toBe(false);
    }
  });

  it('requires every platform identity source and keeps the exact three expression modes', () => {
    for (const expressionStyle of ['concise', 'structured', 'exploratory']) {
      expect(
        EmployeeRuntimePackageSchema.parse({
          ...package3,
          foundation: {
            ...foundation,
            identity: { ...foundation.identity, expressionStyle },
          },
        }),
      ).toMatchObject({ foundation: { identity: { expressionStyle } } });
    }
    for (const field of ['name', 'description', 'appearance', 'identity']) {
      const missing = { ...foundation } as Record<string, unknown>;
      delete missing[field];
      expect(
        EmployeeRuntimePackageSchema.safeParse({
          ...package3,
          foundation: missing,
        }).success,
      ).toBe(false);
    }
    for (const field of Object.keys(foundation.identity)) {
      const identity = { ...foundation.identity } as Record<string, unknown>;
      delete identity[field];
      expect(
        EmployeeRuntimePackageSchema.safeParse({
          ...package3,
          foundation: { ...foundation, identity },
        }).success,
      ).toBe(false);
    }
    expect(
      EmployeeRuntimePackageSchema.safeParse({
        ...package3,
        foundation: {
          ...foundation,
          identity: {
            ...foundation.identity,
            expressionStyle: 'arbitrary free text',
          },
        },
      }).success,
    ).toBe(false);
  });

  it.each([1, 2])(
    'keeps schema %s legacy-only and never fills new fields',
    (schemaVersion) => {
      const legacy = {
        schemaVersion,
        packageVersion: package3.packageVersion,
        checksum: package3.checksum,
        capabilityFingerprint: package3.capabilityFingerprint,
        files: {
          agentsMd: 'agents',
          identityMd: 'identity',
          soulMd: 'soul',
          userMd: 'user',
        },
        skills: [],
        runtimeManifest: {
          ...package3.runtimeManifest,
          instructionPrecedence: [
            'platform-hard-policy',
            'identity',
            'behavior',
            'work-rules',
            'tenant-user-context',
            'runtime-authorization',
            'user-request',
            'skill-details',
          ],
        },
      };
      expect(JSON.stringify(EmployeeRuntimePackageSchema.parse(legacy))).toBe(
        JSON.stringify(legacy),
      );
      expect(
        EmployeeRuntimePackageSchema.safeParse({ ...legacy, foundation })
          .success,
      ).toBe(false);
      expect(
        EmployeeRuntimePackageSchema.safeParse({
          ...legacy,
          platformPolicy: package3.platformPolicy,
        }).success,
      ).toBe(false);
    },
  );
});

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
    expect(snapshot).not.toHaveProperty('nativePreferences');
    expect(snapshot).not.toHaveProperty('subagentMode');
    const nativePreferences = {
      version: 1,
      questionWait: { mode: 'default' },
      subagents: { maxDepth: 1, maxActive: 8 },
    };
    const parse = (fields: Record<string, unknown>) =>
      EmployeeExecutionSnapshotSchema.parse({ ...snapshot, ...fields });
    for (const fields of [{}, { nativePreferences }]) {
      expect(parse(fields)).toEqual({ ...snapshot, ...fields });
    }
    for (const subagents of [
      { maxDepth: null, maxActive: null },
      { maxDepth: null, maxActive: 8 },
      { maxDepth: 0, maxActive: null },
    ]) {
      const preferences = { ...nativePreferences, subagents };
      expect(parse({ nativePreferences: preferences })).toEqual({
        ...snapshot,
        nativePreferences: preferences,
      });
    }
    for (const questionWait of [
      { mode: 'forever' },
      { mode: 'timed', seconds: 1 },
      { mode: 'timed', seconds: 2_147_483 },
    ]) {
      for (const limit of [0, Number.MAX_SAFE_INTEGER]) {
        const preferences = {
          version: 1,
          questionWait,
          subagents: { maxDepth: limit, maxActive: Math.max(1, limit) },
        };
        expect(parse({ nativePreferences: preferences })).toEqual({
          ...snapshot,
          nativePreferences: preferences,
        });
      }
    }
    for (const questionWait of [
      { mode: 'unknown' },
      { mode: 'timed' },
      { mode: 'default', seconds: 1 },
      ...[0, 1.5, 2_147_484, '1'].map((seconds) => ({
        mode: 'timed',
        seconds,
      })),
    ]) {
      expect(() =>
        parse({ nativePreferences: { ...nativePreferences, questionWait } }),
      ).toThrow();
    }
    for (const subagents of [
      {},
      { maxDepth: -1, maxActive: 8 },
      { maxDepth: 1, maxActive: 0 },
      { maxDepth: 1.5, maxActive: 8 },
      { maxDepth: 1, maxActive: Number.MAX_SAFE_INTEGER + 1 },
      { ...nativePreferences.subagents, extra: true },
    ]) {
      expect(() =>
        parse({ nativePreferences: { ...nativePreferences, subagents } }),
      ).toThrow();
    }
    for (const fields of [
      { nativePreferences: null },
      { nativePreferences: {} },
      { nativePreferences: { ...nativePreferences, version: 2 } },
      { nativePreferences: { ...nativePreferences, extra: true } },
      { subagentMode: 'native' },
      { nativePreferences, subagentMode: 'native' },
      { subagentMode: 'legacy' },
      { subagentMode: null },
      { unknown: true },
    ]) {
      expect(() => parse(fields)).toThrow();
    }
  });
});

describe('sparse personal appearance', () => {
  it.each([
    {},
    { appearance: {} },
    { appearance: { accentColor: 'blue' } },
    { appearance: { avatarType: 'emoji' } },
    { appearance: { avatarValue: '🍚' } },
    {
      appearance: {
        avatarType: 'image',
        avatarValue: 'https://example.test/avatar.png',
        accentColor: 'indigo',
      },
    },
  ])(
    'retains only explicitly present fields and leaves existing full values intact: %j',
    (profile) => {
      expect(EmployeeInstanceProfileSchema.parse(profile)).toEqual(profile);
    },
  );

  it('keeps an explicitly chosen expression equal to the default as a real override', () => {
    expect(
      EmployeeInstanceProfileSchema.parse({ expressionStyle: 'structured' }),
    ).toEqual({ expressionStyle: 'structured' });
    expect(EmployeeInstanceProfileSchema.parse({})).not.toHaveProperty(
      'expressionStyle',
    );
    for (const expressionStyle of ['concise', 'structured', 'exploratory']) {
      expect(
        EmployeeInstanceProfileSchema.parse({ expressionStyle })
          .expressionStyle,
      ).toBe(expressionStyle);
    }
    expect(
      EmployeeInstanceProfileSchema.safeParse({
        expressionStyle: 'arbitrary free text',
      }).success,
    ).toBe(false);
  });

  it.each([
    { appearance: { extra: true } },
    { appearance: { avatarType: 'other' } },
    { appearance: { avatarValue: '' } },
    { appearance: { accentColor: 'unknown-color' } },
    { appearance: null },
    { toolNames: ['secret.read'] },
  ])(
    'rejects invalid personal values without granting new fields: %j',
    (profile) => {
      expect(EmployeeInstanceProfileSchema.safeParse(profile).success).toBe(
        false,
      );
    },
  );
});
