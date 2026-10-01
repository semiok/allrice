import { describe, expect, it } from 'vitest';
import { appendComposerDraft, renderTaskSuggestion } from './composer-draft';

describe('preparing a task draft only', () => {
  it('renders repeated names, Chinese/emoji and selects the first replacement using DOM offsets', () => {
    const prepared = renderTaskSuggestion({
      id: 'summary',
      title: '总结',
      template: '🚀整理 {{days}} 天，输出 {{用途}}；范围仍为 {{days}} 天。',
      slots: [
        { name: 'days', label: '天数', defaultValue: '7' },
        { name: '用途', label: '用途', defaultValue: '科研👩‍🔬总结' },
      ],
    });
    expect(prepared.text).toBe('🚀整理 7 天，输出 科研👩‍🔬总结；范围仍为 7 天。');
    expect(
      prepared.text.slice(prepared.selectionStart, prepared.selectionEnd),
    ).toBe('7');
    expect(prepared.selectionStart).toBe(5);
  });
  it('appends without replacing any original bracket text or existing attachments/references', () => {
    const original = '[原文] {{不替换}}\n\n保留空白 ',
      attachments = [{ id: 'attachment' }],
      references = [{ sessionId: 'source' }];
    const state = { draft: original, attachments, references };
    const prepared = renderTaskSuggestion({
      id: 'notice',
      title: '公文',
      template: '起草{{用途}}。',
      slots: [{ name: '用途', label: '用途', defaultValue: '通知' }],
    });
    const next = {
      ...state,
      draft: appendComposerDraft(state.draft, prepared).text,
    };
    expect(next.draft).toBe(`${original}\n\n起草通知。`);
    expect(next.attachments).toBe(attachments);
    expect(next.references).toBe(references);
    const appended = appendComposerDraft(original, prepared);
    expect(
      appended.text.slice(appended.selectionStart, appended.selectionEnd),
    ).toBe('通知');
    expect(appendComposerDraft('', prepared)).toEqual(prepared);
  });
  it('requires missing values and rejects choices outside the configured list', () => {
    const task = {
      id: 'plan',
      title: '计划',
      template: '为{{goal}}制定{{days}}天计划。',
      slots: [
        { name: 'goal', label: '目标', required: true },
        {
          name: 'days',
          label: '天数',
          defaultValue: '7',
          options: ['7', '30'],
        },
      ],
    };
    expect(() => renderTaskSuggestion(task)).toThrow('请填写目标');
    expect(() =>
      renderTaskSuggestion(task, { goal: '研究', days: '14' }),
    ).toThrow('请选择天数');
    expect(renderTaskSuggestion(task, { goal: '研究' }).text).toBe(
      '为研究制定7天计划。',
    );
  });
  it('renders optional fixed choices without an implicit missing-value failure and bounds expanded text', () => {
    expect(
      renderTaskSuggestion({
        id: 'format',
        title: '格式',
        template: '输出{{format}}。',
        slots: [{ name: 'format', label: '格式', options: ['总结', '纪要'] }],
      }).text,
    ).toBe('输出总结。');
    expect(() =>
      renderTaskSuggestion({
        id: 'long',
        title: '过长',
        template: '{{value}}'.repeat(30),
        slots: [
          { name: 'value', label: '参数', defaultValue: 'x'.repeat(2000) },
        ],
      }),
    ).toThrow('草稿过长');
  });
});
