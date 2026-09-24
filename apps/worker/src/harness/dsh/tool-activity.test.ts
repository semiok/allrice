import { describe, expect, it } from 'vitest';
import { toolActivityDetail } from './tool-activity.js';

describe('public tool activity descriptions', () => {
  it('describes only the actual target and omits workspace paths and URL credentials', () => {
    expect(toolActivityDetail('market.quote', { symbol: 'NVDA' })).toBe(
      '查询 NVDA 的实时行情',
    );
    expect(
      toolActivityDetail('workspace.export.create', {
        fileName: '报告.docx',
        content: 'private content',
      }),
    ).toBe('生成文件：报告.docx');
    expect(
      toolActivityDetail('local.fs.read', {
        path: '/private/customer/预算.xlsx',
      }),
    ).toBe('阅读文件：预算.xlsx');
    expect(
      toolActivityDetail('web.fetch', {
        url: 'https://user:secret@example.com/a?token=secret',
      }),
    ).toBe('浏览 example.com 网页');
  });
  it('reuses the native Chinese purpose without copying scripts, results or reasoning', () => {
    expect(
      toolActivityDetail('bash', {
        description: '整理季度营收数据',
        command: 'private command',
      }),
    ).toBe('整理季度营收数据');
    expect(
      toolActivityDetail('bash', {
        command: 'python private.py',
        reasoning: 'private reasoning',
      }),
    ).toBeUndefined();
    expect(
      toolActivityDetail('bash', {
        description: '中文注释\npython private.py',
      }),
    ).toBeUndefined();
    expect(
      toolActivityDetail('unknown', { arguments: 'private' }),
    ).toBeUndefined();
    expect(toolActivityDetail('market.quote', {})).toBeUndefined();
  });
});
