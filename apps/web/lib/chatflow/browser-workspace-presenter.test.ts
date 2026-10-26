import { describe, expect, it } from 'vitest';
import {
  browserActionSummary,
  browserOperationStatusLabel,
  browserStateLabel,
  shortDateTime,
} from './browser-workspace-presenter';

describe('browser panel wording', () => {
  it('names actions and states without engineering terms', () => {
    expect(
      browserActionSummary({
        type: 'navigate',
        url: 'https://www.feishu.cn/product',
      }),
    ).toBe('打开 www.feishu.cn');
    expect(browserOperationStatusLabel('waiting_user')).toBe('等你确认');
    expect(browserOperationStatusLabel('unknown')).toBe('结果待确认');
    expect(browserStateLabel('unknown')).toBe('结果待确认');
    expect(browserStateLabel('something-new')).toBe('状态待确认');
  });

  it('formats times as 「11 月 1 日 09:00」 and adds the year only when it differs', () => {
    const now = new Date(2026, 9, 26, 12);
    expect(shortDateTime(new Date(2026, 10, 1, 9, 5).toISOString(), now)).toBe(
      '11 月 1 日 09:05',
    );
    expect(shortDateTime(new Date(2025, 0, 2, 18).toISOString(), now)).toBe(
      '2025 年 1 月 2 日 18:00',
    );
    expect(shortDateTime('not a date', now)).toBe('');
  });
});
