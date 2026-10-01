import { describe, expect, it } from 'vitest';
import { TaskSuggestionsSchema } from './task-suggestions.ts';

const task = {
  id: 'weekly-summary',
  title: '周报',
  template: '整理最近 {{days}} 天的工作，输出{{format}}；范围为 {{days}} 天。',
  slots: [
    { name: 'days', label: '天数', defaultValue: '7' },
    { name: 'format', label: '格式', required: true },
  ],
};

describe('fixed employee task metadata', () => {
  it('accepts repeated named slots without creating implicit parameters', () => {
    expect(TaskSuggestionsSchema.parse([task])[0]).toEqual(task);
    expect(TaskSuggestionsSchema.parse([])).toEqual([]);
  });
  it('rejects missing/duplicate/unused slots and malformed template markers', () => {
    for (const invalid of [
      { ...task, slots: [] },
      { ...task, slots: [...task.slots, task.slots[0]] },
      { ...task, slots: [...task.slots, { name: 'unused', label: '未使用' }] },
      { ...task, template: '{{days' },
      { ...task, template: '{{days}} {{format}} }}' },
    ])
      expect(TaskSuggestionsSchema.safeParse([invalid]).success).toBe(false);
  });
  it('bounds lists and choices and requires stable unique IDs', () => {
    expect(TaskSuggestionsSchema.safeParse([task, task]).success).toBe(false);
    expect(
      TaskSuggestionsSchema.safeParse(
        Array.from({ length: 9 }, (_, i) => ({ ...task, id: `task-${i}` })),
      ).success,
    ).toBe(false);
    expect(
      TaskSuggestionsSchema.safeParse([
        {
          ...task,
          slots: [
            {
              name: 'days',
              label: '天数',
              defaultValue: '7',
              options: ['1', '3'],
            },
            task.slots[1],
          ],
        },
      ]).success,
    ).toBe(false);
    expect(
      TaskSuggestionsSchema.safeParse([{ ...task, unexpectedExecution: true }])
        .success,
    ).toBe(false);
  });
});
