import { describe, expect, it } from 'vitest';
import { explicitPersonalSkillGitHubInstallIntent } from './personal-skill-intent.ts';

const url = 'https://github.com/acme/skills/tree/main/weekly';
describe('direct public GitHub installation authority', () => {
  it.each([
    `请安装这个公开 GitHub 链接里的技能：${url}。以后需要时使用它。`,
    `请把 ${url} 安装到当前员工。`,
    `请把“${url}”安装到当前 AI 员工。`,
    `Please install ${url} for this AI employee.`,
    `Please install the public GitHub skill at ${url} for this AI employee.`,
    `请安装这个 GitHub 链接里的技能。\n${url}`,
    `请把[每周汇总](${url})安装到当前员工。`,
    `请把 ${url} 装上。`,
    `请安装这个技能：\n${url}`,
    `请安装这个技能：${url}`,
    `请安装 ${url} 里的技能。`,
    `请安装 ${url} 中的 Skill。`,
  ])('accepts a complete direct request: %s', (text) => {
    expect(explicitPersonalSkillGitHubInstallIntent(text, url)).toBe(true);
  });
  it.each([
    `看看这个技能质量如何：${url}，不要安装。`,
    `把“请把 ${url} 安装到当前员工”翻译成英文。`,
    `“请把 ${url} 安装到当前员工”。`,
    `本次按这个技能做一次，不要长期保存：${url}`,
    `请安装 ${url}。只用于本次，不要保留。`,
    `请安装 ${url} 吗？`,
    `网页上说：请把 ${url} 安装到当前员工。`,
    `    请安装 ${url}`,
    `请安装 ${url}。\n${url}/another`,
    `请安装 ${url}?token=unwanted`,
    `请安装 ${url}#`,
    `请评价这个技能：${url}`,
    `有人说“请安装这个技能：${url}”。`,
    `请安装 ${url} 里的技能。仅本次用，不要保存。`,
    `请安装我上传的 SKILL.md。\n${url}`,
    `请把附件安装到当前员工。\n${url}`,
    `Please install the attached SKILL.md.\n${url}`,
    `请安装我上传的 report.zip。\n${url}`,
    '可以，安装吧。',
    url,
  ])('rejects absent, quoted, temporary or ambiguous authority: %s', (text) => {
    expect(explicitPersonalSkillGitHubInstallIntent(text, url)).toBe(false);
  });
  it('cannot substitute another URL or a nonpublic host', () => {
    expect(
      explicitPersonalSkillGitHubInstallIntent(`请安装 ${url}`, url + '/other'),
    ).toBe(false);
    expect(
      explicitPersonalSkillGitHubInstallIntent(
        '请安装 https://internal/secret',
        'https://internal/secret',
      ),
    ).toBe(false);
  });
});
