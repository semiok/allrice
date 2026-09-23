import { describe, expect, it } from 'vitest';
import {
  runtimeCapabilityFacts,
  integratedCapabilityStatus,
  type RuntimeCapabilityResponse,
} from './runtime-capability-facts';
const data = (): RuntimeCapabilityResponse => ({
  checkedAt: new Date().toISOString(),
  skills: [],
  webTools: [
    { name: 'assistant.delegate', enabled: true },
    { name: 'assistant.report', enabled: true },
  ],
  publications: [
    {
      employeeName: 'Rice',
      workspaceId: 'workspace',
      workspaceName: 'Test',
      version: 2,
      skillIds: ['skill-a', 'skill-b'],
      toolNames: ['assistant.delegate', 'assistant.report'],
      policyEnabled: true,
      policyMode: 'execute',
    },
  ],
  workers: [
    {
      schemaVersion: 1,
      workerId: 'worker',
      releaseSha: null,
      version: '0.1.5-rc.3',
      profileDigest: null,
      profileStatus: 'read',
      observedAt: new Date().toISOString(),
      online: true,
      components: [
        {
          id: 'extra',
          packageName: '@example/new-plugin',
          version: '1.0.0',
          state: 'configured',
        },
        {
          id: 'missing',
          packageName: '@example/missing',
          version: null,
          state: 'missing',
        },
      ],
      tools: [
        { name: 'assistant.delegate', enabled: true },
        { name: 'assistant.report', enabled: true },
      ],
    },
  ],
});
describe('live capability projection', () => {
  it('counts actual configuration and published Skill IDs, not static catalog entries', () => {
    const input = data();
    input.publications.push({
      ...input.publications[0]!,
      skillIds: ['skill-a'],
    });
    expect(runtimeCapabilityFacts(input)).toMatchObject({
      componentCount: '1',
      enhancementCount: '0',
      publishedSkillIds: new Set(['skill-a', 'skill-b']),
    });
  });
  it('does not turn an expired/missing Worker or a failed API into zero or enabled capabilities', () => {
    const input = data();
    input.workers[0]!.online = false;
    expect(runtimeCapabilityFacts(input).componentCount).toBe('—');
    expect(integratedCapabilityStatus('assistants', input)).toBe(
      '运行状态未知',
    );
    expect(integratedCapabilityStatus('native-images', null)).toBe(
      '运行状态未知',
    );
  });
  it('reports mixed Workers rather than taking whichever report arrived last', () => {
    const input = data();
    input.workers.push({
      ...input.workers[0]!,
      workerId: 'other',
      components: [],
      tools: [],
    });
    expect(runtimeCapabilityFacts(input).componentCount).toBe('0–1');
    expect(integratedCapabilityStatus('assistants', input)).toBe(
      'Worker 配置不一致',
    );
  });
  it('checks both services and tenant publication before claiming a released capability', () => {
    const input = data();
    expect(integratedCapabilityStatus('assistants', input)).toContain(
      '已发布到 1 个工作区',
    );
    input.webTools = [];
    expect(integratedCapabilityStatus('assistants', input)).toBe(
      'Web 功能开关未开启',
    );
    input.webTools = input.workers[0]!.tools;
    input.publications[0]!.policyEnabled = false;
    expect(integratedCapabilityStatus('assistants', input)).toBe(
      '已发布 · 租户执行策略未开启',
    );
    input.publications = [];
    expect(integratedCapabilityStatus('assistants', input)).toBe(
      '尚未发布到租户员工',
    );
    input.workers[0]!.tools = [];
    expect(integratedCapabilityStatus('assistants', input)).toBe(
      'Worker 功能开关未开启',
    );
  });
});
