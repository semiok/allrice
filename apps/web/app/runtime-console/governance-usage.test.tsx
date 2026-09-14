import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { GovernanceUsageSummary } from './governance-console';

const quota = {
  usedRuns: 2,
  usedTokens: 150,
  usedCostCents: 0,
  unknownCostRuns: 0,
  usageComplete: true,
};
it('keeps a known zero estimate distinct from unavailable pricing', () => {
  const known = renderToStaticMarkup(<GovernanceUsageSummary quota={quota} />);
  expect(known).toContain('0.00');
  expect(known).toContain('分（估算）');
  expect(known).not.toContain('待核对');
  const unknown = renderToStaticMarkup(
    <GovernanceUsageSummary
      quota={{ ...quota, usedCostCents: null, unknownCostRuns: 2 }}
    />,
  );
  expect(unknown).toContain('费用待核对');
  expect(unknown).toContain('2 次运行缺少可用费用估算');
  expect(unknown).not.toContain('0.00');
});
it('does not present a confirmed subtotal as complete token usage', () => {
  const html = renderToStaticMarkup(
    <GovernanceUsageSummary
      quota={{
        ...quota,
        usageComplete: false,
        usedCostCents: null,
        unknownCostRuns: 1,
      }}
    />,
  );
  expect(html).toContain('150');
  expect(html).toContain('部分用量待核对');
});
