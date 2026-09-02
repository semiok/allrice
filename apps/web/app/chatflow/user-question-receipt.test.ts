import { describe, expect, it } from 'vitest';

import { projectUserQuestionReceipt } from './user-question-receipt';

describe('user question receipt', () => {
  it('separates recommendation metadata from the selected label', () => {
    expect(
      projectUserQuestionReceipt('文件格式：xlsm (Recommended)', {
        questionId: 'question-1',
        answers: [{ id: 'format', selected: ['xlsm (Recommended)'] }],
      }),
    ).toEqual([
      {
        id: 'format',
        title: '文件格式',
        values: [{ label: 'xlsm', recommended: true }],
        skipped: false,
      },
    ]);
  });

  it('keeps multi-select, custom and skipped answers in one receipt', () => {
    expect(
      projectUserQuestionReceipt('来源：官网、其他\n范围：跳过', {
        questionId: 'question-2',
        answers: [
          { id: 'source', selected: ['官网'], custom: '行业数据库' },
          { id: 'scope', selected: [] },
        ],
      }),
    ).toMatchObject([
      {
        title: '来源',
        values: [
          { label: '官网', recommended: false },
          { label: '行业数据库', recommended: false },
        ],
        skipped: false,
      },
      { title: '范围', values: [], skipped: true },
    ]);
  });
});
