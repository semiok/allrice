import { describe, expect, it } from 'vitest';
import { explicitPersonalSkillInstallIntent as allows } from './personal-skill-intent.ts';
import { explicitPersonalSkillSelectionIntent as select } from './personal-skill-intent.ts';
import { explicitPersonalSkillCancelIntent as cancel } from './personal-skill-intent.ts';

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

describe('package installation and candidate choice', () => {
  it.each([
    '请把我上传的“weekly.zip”安装到当前 AI 员工。以后使用这个技能。',
    '这是一个技能包；请帮我安装 weekly.zip！',
    'Please install the attached weekly.zip for this employee.',
    '请安装我上传的技能包。',
    '请安装我上传的 ZIP 里的技能，给当前 AI 员工使用。',
    '请安装这个 ZIP 里的技能。如果有多个，先让我选一个。',
  ])('accepts direct package request %s', (text) =>
    expect(allows(text, 'weekly.zip')).toBe(true),
  );
  it.each([
    '请评价 weekly.zip。',
    '请安装 weekly.zip。不要保存。',
    '“请安装 weekly.zip”',
    '请翻译：请安装 weekly.zip。',
  ])('rejects package quotation/review %s', (text) =>
    expect(allows(text, 'weekly.zip')).toBe(false),
  );
  const candidates = [
    { sourcePath: 'skills/weekly/SKILL.md', definition: { name: 'weekly' } },
    { sourcePath: 'skills/monthly/SKILL.md', definition: { name: 'monthly' } },
  ];
  it.each([
    '请选择“weekly”并安装。',
    '安装 skills/weekly/SKILL.md。以后使用这个技能。',
    'Please select weekly and install.',
    '我选 weekly，请安装到当前员工。',
  ])('matches one named candidate %s', (text) =>
    expect(select(text, candidates)).toBe(candidates[0]!.sourcePath),
  );
  it.each([
    '第一个',
    '都安装',
    '不要安装 weekly',
    '请临时使用 weekly',
    '“安装 weekly”',
    '请翻译：安装 weekly',
    '安装 weekly。安装 monthly。',
    '安装 weekly。不要保存。',
    '    安装 weekly',
    '请安装 unknown',
  ])('rejects ambiguous/quoted/transient choice %s', (text) =>
    expect(select(text, candidates)).toBe(null),
  );
  it('requires a path if candidate names collide', () =>
    expect(
      select('安装 weekly', [
        ...candidates,
        { sourcePath: 'other/SKILL.md', definition: { name: 'weekly' } },
      ]),
    ).toBe(null));
  it.each([
    '刚才那个 ZIP 先不装了。',
    '请取消这个技能包的安装。',
    '取消 weekly.zip 导入。',
  ])('accepts direct cancellation %s', (text) =>
    expect(cancel(text, 'weekly.zip')).toBe(true),
  );
  it.each([
    '请翻译：“取消这个技能包的安装”。',
    '“刚才那个 ZIP 先不装了”',
    '    取消这个技能包',
    '如果失败取消这个技能包',
  ])('rejects quoted/conditional cancellation %s', (text) =>
    expect(cancel(text, 'weekly.zip')).toBe(false),
  );
});
