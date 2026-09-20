import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect } from 'vitest';
import { RunUsageSummary } from './run-usage';
import type { RuntimeRunUsage } from '@allrice/contracts';

const usage: RuntimeRunUsage = {
  inputTokens: 203744,
  cachedInputTokens: 173568,
  outputTokens: 4677,
  totalTokens: 208421,
  usageComplete: true,
  cacheUsageKnown: true,
  attemptCount: 1,
  receiptCount: 1,
};
describe('per-Run recorded token usage', () => {
  it('shows the exact gross total and cache subset without adding cache twice', () => {
    const html = renderToStaticMarkup(
      <RunUsageSummary usage={usage} runStatus="succeeded" />,
    );
    for (const value of [
      '208,421',
      '173,568',
      '203,744',
      '4,677',
      '总量＝输入＋输出',
    ])
      expect(html).toContain(value);
    expect(html).not.toContain('381,989');
    expect(html).not.toContain('警告');
  });
  it.each([null, undefined, { ...usage, receiptCount: 0 }])(
    'does not present missing receipts as zero',
    (missing) => {
      const html = renderToStaticMarkup(
        <RunUsageSummary usage={missing} runStatus="failed" />,
      );
      expect(html).toContain('暂无用量回执');
      expect(html).not.toContain('208,421');
    },
  );
  it('marks partial totals and unknown cache distinctly', () => {
    const html = renderToStaticMarkup(
      <RunUsageSummary
        usage={{
          ...usage,
          usageComplete: false,
          cacheUsageKnown: false,
          cachedInputTokens: null,
          attemptCount: 2,
        }}
        runStatus="failed"
      />,
    );
    for (const value of [
      '已确认累计',
      '用量未完整',
      '未知',
      '缓存明细未完整',
      '2 次执行尝试',
    ])
      expect(html).toContain(value);
  });
  it('never presents an active Run subtotal as its final total', () => {
    const html = renderToStaticMarkup(
      <RunUsageSummary usage={usage} runStatus="running" />,
    );
    expect(html).toContain('运行中，用量待结算');
    expect(html).toContain('已确认累计');
  });
  it('preserves a known zero receipt', () => {
    const html = renderToStaticMarkup(
      <RunUsageSummary
        usage={{
          ...usage,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedInputTokens: 0,
        }}
        runStatus="failed"
      />,
    );
    expect(html).toContain('<strong>0</strong> Token');
    expect(html).not.toContain('暂无用量回执');
  });
});
