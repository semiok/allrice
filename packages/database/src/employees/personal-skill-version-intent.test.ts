import { describe, it, expect } from 'vitest';
import {
  explicitPersonalSkillUpdateIntent as update,
  explicitPersonalSkillRollbackIntent as rollback,
  explicitPersonalSkillVersionConfirmation as confirm,
  skillVersionConfirmation,
  explicitPersonalSkillBind,
} from './personal-skill-version-intent.ts';
describe('complete source-bound personal version authority', () => {
  it.each([
    '请将 weekly 更新为我上传的 SKILL.md。',
    '请把“weekly”更新到“SKILL.md”；后续任务请使用新版本！',
    'Please update weekly from the attached SKILL.md.',
  ])('accepts explicit update %s', (text) =>
    expect(update(text, 'weekly', 'SKILL.md')).toBe(true),
  );
  it.each([
    '“请将 weekly 更新为 SKILL.md。”',
    '请翻译：请将 weekly 更新为 SKILL.md。',
    '请将 weekly 更新为 SKILL.md。不要保存。',
    '本次临时按 SKILL.md 使用 weekly。',
    '请将 monthly 更新为 SKILL.md。',
    '    请将 weekly 更新为 SKILL.md。',
    '请将 weekly 更新为 SKILL.md，只改当前员工。',
  ])('rejects quotation/temporary/narrow scope %s', (text) =>
    expect(update(text, 'weekly', 'SKILL.md')).toBe(false),
  );
  it('binds a GitHub source containing the target name', () => {
    const url = 'https://github.com/acme/weekly/tree/main/weekly';
    expect(update(`请将 weekly 更新为 ${url}。`, 'weekly', url, true)).toBe(
      true,
    );
    expect(
      update(`请将 weekly 更新为 SKILL.md。\n${url}`, 'weekly', url, true),
    ).toBe(false);
    expect(
      update(
        `请将 weekly 更新为 ${url}。\nhttps://github.com/other/source`,
        'weekly',
        url,
        true,
      ),
    ).toBe(false);
  });
  it('accepts the actual multi-sentence version acceptance request', () => {
    expect(
      update(
        '请将“qa-version-check”更新为我上传的“version-v2.zip”。后续任务都使用新版本。',
        'qa-version-check',
        'version-v2.zip',
      ),
    ).toBe(true);
    expect(
      rollback('请将“qa-version-check”回退到 v1。', 'qa-version-check', 1),
    ).toBe(true);
  });
  it('requires an exact rollback version and fresh complete confirmation text', () => {
    expect(rollback('请将“weekly”回退到 v1。', 'weekly', 1)).toBe(true);
    expect(rollback('请将 weekly 回退到 v2。', 'weekly', 1)).toBe(false);
    const text = skillVersionConfirmation('weekly', 'rollback', 1);
    expect(confirm(text, text)).toBe(true);
    expect(confirm(text.replaceAll('，', ',').replaceAll(' ', ''), text)).toBe(
      true,
    );
    for (const bad of [
      '好',
      `“${text}”`,
      text + '不要保存。',
      text.replace('全部已绑定员工', '当前员工'),
      '    ' + text,
    ])
      expect(confirm(bad, text)).toBe(false);
  });
  it('never treats placeholder words as an actual target or source', () => {
    for (const text of ['请把技能 target 绑定给你', '请把技能 TaRgEt 绑定给你'])
      expect(explicitPersonalSkillBind(text, 'weekly-report')).toBe(false);
    for (const text of [
      'update target from source',
      'update TARGET from SOURCE',
      '请将 target 更新为 SKILL.md',
      '请将 weekly 更新为 source',
    ])
      expect(update(text, 'weekly', 'SKILL.md')).toBe(false);
    expect(rollback('请将 target 回退到 v1', 'weekly', 1)).toBe(false);
    expect(
      explicitPersonalSkillBind('请把技能 target 绑定给你', 'target'),
    ).toBe(true);
  });
});
