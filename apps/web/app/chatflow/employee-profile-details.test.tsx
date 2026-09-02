import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  EmployeeProfileDetails,
  type EmployeeProfileDetailsData,
} from './employee-profile-details';

const profile: EmployeeProfileDetailsData = {
  name: 'Rice',
  description: '负责把目标变成可交付结果。',
  identity: {
    role: '研究助理',
    mission: '完成可信研究',
    workStyle: '先验证，再总结',
    behaviorRules: ['标注来源', '说明不确定性'],
    safetyBoundaries: ['不泄露租户数据'],
  },
  skills: [
    {
      id: 'research',
      name: '深度研究',
      description: '检索并综合多方资料。',
    },
  ],
  model: {
    harness: 'dsh',
    provider: 'openai-codex',
    model: 'gpt-5-codex',
    reasoningEffort: 'xhigh',
  },
};

describe('EmployeeProfileDetails', () => {
  it('renders the employee profile sections and display labels in order', () => {
    const html = renderToStaticMarkup(
      <EmployeeProfileDetails profile={profile} />,
    );

    expect(html).toContain('>R</span>');
    expect(html).toContain('<strong>研究助理</strong>');
    expect(html).toContain('<p>负责把目标变成可交付结果。</p>');
    expect(html).toContain('由 AllRice 管理员配置');
    expect(html).toContain('<dd>完成可信研究</dd>');
    expect(html).toContain('<dd>先验证，再总结</dd>');
    expect(html).toContain('<li>标注来源</li>');
    expect(html).toContain('<li>说明不确定性</li>');
    expect(html).toContain('<li>不泄露租户数据</li>');
    expect(html).toContain('<strong>深度研究</strong>');
    expect(html).toContain('<dd>DSH</dd>');
    expect(html).toContain('<dd>Codex 订阅</dd>');
    expect(html).toContain('<dd>gpt-5-codex</dd>');
    expect(html).toContain('<dd>极高</dd>');
    expect(html.match(/<section/g)).toHaveLength(3);
    expect(html.indexOf('人设')).toBeLessThan(html.indexOf('技能'));
    expect(html.indexOf('技能')).toBeLessThan(html.indexOf('模型'));
  });

  it.each([
    ['openai-codex', 'Codex 订阅'],
    ['codex', 'Codex 订阅'],
    ['deepseek-official', 'DeepSeek API'],
    ['deepseek', 'DeepSeek API'],
    ['openai-compatible', '兼容 API'],
  ])('maps provider %s to %s', (provider, label) => {
    const html = renderToStaticMarkup(
      <EmployeeProfileDetails
        profile={{
          ...profile,
          model: { ...profile.model, provider },
        }}
      />,
    );

    expect(html).toContain(`<dd>${label}</dd>`);
  });

  it.each([
    ['none', '关闭'],
    ['low', '低'],
    ['medium', '中'],
    ['high', '高'],
    ['xhigh', '极高'],
  ])('maps reasoning effort %s to %s', (reasoningEffort, label) => {
    const html = renderToStaticMarkup(
      <EmployeeProfileDetails
        profile={{
          ...profile,
          model: { ...profile.model, reasoningEffort },
        }}
      />,
    );

    expect(html).toContain(`<dd>${label}</dd>`);
  });

  it('keeps empty and passthrough display states', () => {
    const html = renderToStaticMarkup(
      <EmployeeProfileDetails
        profile={{
          ...profile,
          identity: {
            ...profile.identity,
            behaviorRules: [],
            safetyBoundaries: [],
          },
          skills: [],
          model: {
            ...profile.model,
            provider: 'tenant-provider',
            reasoningEffort: 'custom',
          },
        }}
      />,
    );

    expect(html).not.toContain('行为准则');
    expect(html).not.toContain('工作边界');
    expect(html).toContain('暂未配置专属技能。');
    expect(html).toContain('<dd>tenant-provider</dd>');
    expect(html).toContain('<dd>custom</dd>');
  });
});
