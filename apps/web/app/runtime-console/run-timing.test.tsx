import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunTimingSummary } from './run-timing';

describe('per-Run runtime policy projection', () => {
  it('shows actual frozen time, pause, source and unknown receipts without a quota warning', () => {
    const html = renderToStaticMarkup(
      <RunTimingSummary
        timing={{
          activeMs: 300000,
          waitingMs: 2400000,
          wallMs: 2700000,
          timeoutMs: 0,
          remainingMs: null,
          phase: 'waiting',
          sources: [{ scope: 'user', timeoutMs: 0 }],
          calls: { modelRequests: 81, toolCalls: 100, pending: 1 },
        }}
      />,
    );
    for (const text of [
      '不限制',
      '5 分 0 秒',
      '40 分 0 秒',
      '45 分 0 秒',
      '用户',
      '活跃计时暂停',
      '81',
      '100',
      '不代表 0 消耗',
      '调用次数仅统计',
    ])
      expect(html).toContain(text);
    expect(html).not.toContain('超限');
  });
  it('does not fabricate statistics for an old Run', () => {
    expect(renderToStaticMarkup(<RunTimingSummary timing={null} />)).toBe('');
  });
});
