import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
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
});
