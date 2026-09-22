import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnknownUsageReviewCard } from './unknown-usage-review';
import { GovernanceUsageSummary } from './governance-console';
const entry = {
  decisionId: 'd',
  runId: '12345678-test',
  provider: 'openai-codex',
  model: 'test',
  occurredAt: '2026-09-20',
  knownTokens: 0,
  reservedTokens: null,
  approved: false,
  eligible: true,
  reason: null,
  reviewedAt: null,
};
describe('unknown usage operator UI', () => {
  it('never asks for an arbitrary reservation in subscription observation mode', () => {
    const html = renderToStaticMarkup(
      <UnknownUsageReviewCard
        entry={{ ...entry, tokenObservationOnly: true }}
        busy={false}
        onReview={async () => {}}
      />,
    );
    expect(html).toContain('无需填写预留预算');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).toContain('原始未知记录保留');
  });
  it('never enables recovery before explicit confirmation/reason and labels holds as non-usage', () => {
    const html = renderToStaticMarkup(
      <UnknownUsageReviewCard
        entry={entry}
        busy={false}
        onReview={async () => {}}
      />,
    );
    expect(html).toContain('不是扣费');
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/<button disabled=""/);
  });
  it('retains unknown after approval and refuses changed/noneligible records', () => {
    const html = renderToStaticMarkup(
      <UnknownUsageReviewCard
        entry={{ ...entry, approved: true, reservedTokens: 1_000_000 }}
        busy={false}
        onReview={async () => {}}
      />,
    );
    expect(html).toContain('实际用量仍未知');
    expect(html).not.toContain('<button');
    const denied = renderToStaticMarkup(
      <UnknownUsageReviewCard
        entry={{ ...entry, eligible: false }}
        busy={false}
        onReview={async () => {}}
      />,
    );
    expect(denied).toContain('不可直接放行');
    expect(denied).not.toContain('<button');
  });
  it('separates actual known subtotal and reserved organization budget', () => {
    const html = renderToStaticMarkup(
      <GovernanceUsageSummary
        quota={{
          usedRuns: 1,
          usedTokens: 120,
          usedCostCents: null,
          unknownCostRuns: 0,
          subscriptionRuns: 1,
          usageComplete: false,
          reservedTokenBudget: 1_000_000,
        }}
      />,
    );
    expect(html).toContain('部分用量待核对');
    expect(html).toContain('1,000,000');
    expect(html).toContain('非实际用量、非扣费');
  });
});
