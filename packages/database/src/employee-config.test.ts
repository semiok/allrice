import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { employeeManifestChecksum, riceManifest } from './employee-config.js';

describe('Rice employee manifest', () => {
  it('has a stable identity and canonical skill ordering', () => {
    const first = randomUUID();
    const second = randomUUID();
    const manifest = riceManifest([second, first, second]);
    expect(manifest.name).toBe('Rice');
    expect(manifest.provider).toMatchObject({
      provider: 'codex',
      authMode: 'chatgpt_subscription',
      reasoningEffort: 'high',
    });
    expect(manifest.skillVersionIds).toEqual([first, second].sort());
  });

  it('changes the immutable checksum when a SkillVersion changes', () => {
    expect(employeeManifestChecksum(riceManifest())).not.toBe(
      employeeManifestChecksum(riceManifest([randomUUID()])),
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
});
