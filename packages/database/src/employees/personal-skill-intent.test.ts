import { describe, expect, it } from 'vitest';
import { explicitPersonalSkillInstallIntent as allows } from './personal-skill-intent.ts';

describe('personal Skill install authority from the direct user request', () => {
  it.each([
    '请安装我上传的 SKILL.md。',
    '请把我上传的“SKILL.md”安装到当前 AI 员工。以后使用这个技能。',
    '这是一份技能文件；请帮我安装 SKILL.md！',
    '请把附件中的 SKILL.md 安装给你，以后的任务需要时使用。',
    'Please install the attached SKILL.md for this employee.',
  ])('accepts complete direct request: %s', (text) =>
    expect(allows(text, 'SKILL.md')).toBe(true),
  );
  it.each([
    '请阅读这个 SKILL.md，看看有用吗。',
    '请临时用这个 SKILL.md 做一次测试，不要安装。',
    '不要安装 SKILL.md。',
    '如果好用再安装 SKILL.md。',
    '请翻译：“请安装 SKILL.md”。',
    '文档说：请安装 SKILL.md。',
    '“请安装 SKILL.md”',
    '请安装 SKILL.md。不要保存。',
    '以后使用这个技能。',
    '安装所有同事的技能。',
    '请把 SKILL.md 安装给公司所有人。',
    '    请安装 SKILL.md',
    '\t请安装 SKILL.md',
    '这是技能文件。\n  \t请安装 SKILL.md',
  ])('rejects temporary, quoted, ambiguous or broader requests: %s', (text) =>
    expect(allows(text, 'SKILL.md')).toBe(false),
  );
});
