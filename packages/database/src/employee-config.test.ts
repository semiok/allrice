import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  applyEmployeeUserProfilePolicy,
  employeeManifest,
  employeeManifestChecksum,
  employeeManifestTemplateChecksum,
  riceManifest,
} from './employee-config.js';

describe('Rice employee manifest', () => {
  it('has a stable identity and canonical skill ordering', () => {
    const first = randomUUID();
    const second = randomUUID();
    const manifest = riceManifest([second, first, second]);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.name).toBe('Rice');
    expect(manifest.provider).toMatchObject({
      provider: 'codex',
      authMode: 'chatgpt_subscription',
      reasoningEffort: 'high',
    });
    expect(manifest.skillVersionIds).toEqual([first, second].sort());
    if (manifest.schemaVersion === 2) {
      expect(manifest.isDefaultRice).toBe(true);
      expect(manifest.runtimePolicy.harness).toBe('codex');
      expect(manifest.capabilityBindings.skillVersionIds).toEqual(
        manifest.skillVersionIds,
      );
      expect(manifest.securityPolicy.dataScopes).not.toContain('organization');
    }
  });

  it('changes the immutable checksum when a SkillVersion changes', () => {
    const skillVersionId = randomUUID();
    expect(employeeManifestChecksum(riceManifest())).not.toBe(
      employeeManifestChecksum(riceManifest([skillVersionId])),
    );
    expect(employeeManifestTemplateChecksum(riceManifest())).toBe(
      employeeManifestTemplateChecksum(riceManifest([skillVersionId])),
    );
  });

  it('freezes the partner profile into the employee manifest', () => {
    const manifest = riceManifest([], {
      role: '产品经理工作伙伴',
      mission: '把需求和数据转成可执行的产品决策。',
      communicationStyle: 'concise',
      outputLanguage: 'zh-CN',
      proactivePolicy: 'ask',
      approvalPolicy: 'confirm_external',
    });
    expect(manifest.partnerProfile).toMatchObject({
      role: '产品经理工作伙伴',
      communicationStyle: 'concise',
      proactivePolicy: 'ask',
      approvalPolicy: 'confirm_external',
    });
    expect(manifest.systemPrompt).toContain('产品经理工作伙伴');
    expect(manifest.systemPrompt).toContain('external communication');
  });

  it('freezes explicit persona, runtime, tools and security policy together', () => {
    const manifest = employeeManifest({
      key: 'research-partner',
      name: '研究伙伴',
      description: '负责资料核实。',
      identity: {
        role: '研究伙伴',
        mission: '核实资料并形成结论。',
        workStyle: '事实和判断分开表达。',
        behaviorRules: ['保留来源。'],
        safetyBoundaries: ['不得读取其他工作区。'],
      },
      runtimePolicy: {
        harness: 'codex',
        provider: 'codex',
        model: 'gpt-5.6-luna',
        reasoningEffort: 'high',
        timeoutMs: 180_000,
        fallbackModels: [],
      },
      securityPolicy: {
        dataScopes: ['workspace', 'employee', 'user'],
        connectorIdentityModes: ['user'],
        approvalPolicy: 'confirm_external',
        deniedCapabilities: ['secret:use'],
      },
      userProfilePolicy: {
        enabled: true,
        fields: ['preferences'],
        scope: 'employee_user',
      },
      toolNames: ['workspace.file.read'],
    });
    expect(manifest.schemaVersion).toBe(2);
    if (manifest.schemaVersion === 2) {
      expect(manifest.identity.workStyle).toContain('事实');
      expect(manifest.systemPrompt).toContain('事实和判断分开表达');
      expect(manifest.capabilityBindings.toolNames).toEqual([
        'workspace.file.read',
      ]);
      expect(manifest.securityPolicy.approvalPolicy).toBe('confirm_external');
      expect(manifest.userProfilePolicy.fields).toEqual(['preferences']);
    }
  });

  it('injects only user-profile fields allowed by the employee policy', () => {
    const stored = {
      schemaVersion: 1 as const,
      displayName: '沈雪天',
      preferences: { language: 'zh-CN', style: 'concise' },
    };
    expect(
      applyEmployeeUserProfilePolicy(stored, {
        enabled: true,
        fields: ['preferences'],
        scope: 'employee_user',
      }),
    ).toEqual({
      schemaVersion: 1,
      displayName: null,
      preferences: stored.preferences,
    });
    expect(
      applyEmployeeUserProfilePolicy(stored, {
        enabled: false,
        fields: ['displayName', 'preferences'],
        scope: 'employee_user',
      }),
    ).toEqual({ schemaVersion: 1, displayName: null, preferences: {} });
  });
});
