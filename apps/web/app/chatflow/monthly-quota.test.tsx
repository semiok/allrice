import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { UserMonthlyQuota } from '@allrice/contracts';
import { MonthlyQuota, monthlyQuotaPercent } from './monthly-quota';

const data: UserMonthlyQuota = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  userId: '00000000-0000-4000-8000-000000000003',
  displayName: 'Snow',
  monthlyTokenLimit: 5_000_000,
  usedTokens: 2_824_029,
  remainingTokens: 2_175_971,
  remainingPercent: 43.51942,
  unknownUsageRuns: 0,
  periodStart: '2026-09-01T00:00:00Z',
  resetsAt: '2026-10-01T00:00:00Z',
  observedAt: '2026-09-21T08:00:00Z',
};
describe('account monthly balance', () => {
  it('shows statistics, not remaining quota, for subscription observation mode', () => {
    const html = renderToStaticMarkup(
      <MonthlyQuota
        data={{
          ...data,
          codexTokenPolicy: 'observe',
          cachedInputTokens: 2000000,
          unknownUsageRuns: 1,
        }}
        failed={false}
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain('账号使用情况');
    expect(html).toContain('2,000,000');
    expect(html).toContain('有 1 次任务的用量还在统计');
    expect(html).not.toContain('剩余');
    expect(html).not.toContain('5,000,000');
  });
  it('shows the monthly allowance in plain words, without Token or provider names', () => {
    const html = renderToStaticMarkup(
      <MonthlyQuota data={data} failed={false} onRefresh={() => {}} />,
    );
    for (const value of [
      '本月已用',
      '2,824,029',
      '本月上限',
      '5,000,000',
      '2,175,971 · 43%',
      '重置时间',
      '10 月 1 日',
      '用量如何计算',
    ])
      expect(html).toContain(value);
    for (const word of ['Token', 'Codex', 'DSH', '回执', '还在统计'])
      expect(html).not.toContain(word);
  });
  it('does not invent zero/full balance on failed or pending reads', () => {
    for (const failed of [true, false]) {
      const html = renderToStaticMarkup(
        <MonthlyQuota data={null} failed={failed} onRefresh={() => {}} />,
      );
      expect(html).toContain(failed ? '暂不可用' : '读取中');
      expect(html).not.toContain('剩余');
    }
  });
  it('keeps incomplete usage visible in details, not a fabricated total', () => {
    const html = renderToStaticMarkup(
      <MonthlyQuota
        data={{ ...data, unknownUsageRuns: 2 }}
        failed={false}
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain('有 2 次任务的用量还在统计');
    expect(html).toContain('上面是已统计的部分');
  });
  it.each([
    [0, '0%'],
    [0.01, '<1%'],
    [99.99, '99%'],
    [100, '100%'],
  ])('formats %s without rounding up available budget', (input, output) => {
    expect(monthlyQuotaPercent(input as number)).toBe(output);
  });
});
