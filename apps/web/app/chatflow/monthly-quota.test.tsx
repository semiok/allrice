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
    expect(html).toContain('不阻断 Codex 后续聊天');
    expect(html).not.toContain('剩余');
    expect(html).not.toContain('5,000,000');
  });
  it('labels the human account, internal monthly balance, exact totals and reset', () => {
    const html = renderToStaticMarkup(
      <MonthlyQuota data={data} failed={false} onRefresh={() => {}} />,
    );
    for (const value of [
      'Snow',
      '剩余 43%',
      '5,000,000',
      '2,824,029',
      '2,175,971',
      '重置时间',
      'AllRice 月额度',
      '不是 Codex 官方订阅余额',
    ])
      expect(html).toContain(value);
    expect(html).not.toContain('用量待核对');
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
    expect(html).toContain('有 2 笔用量待核对');
    expect(html).toContain('余额按已入账用量计算');
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
