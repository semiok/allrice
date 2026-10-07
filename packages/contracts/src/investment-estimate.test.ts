import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvestmentContentSchema,
  InvestmentReportSchema,
  type InvestmentBaseline,
  type InvestmentRevision,
  type InvestmentStatement,
  type InvestmentWork,
} from './investment.ts';
import { estimateInvestment } from './investment-estimate.ts';
const org = randomUUID(),
  owner = randomUUID(),
  from = '2026-10-01T00:00:00Z',
  to = '2026-11-01T00:00:00Z';
function rev(
  content: InvestmentRevision['content'],
  facts: Record<string, unknown> = {},
): InvestmentRevision {
  return {
    id: randomUUID(),
    entryId: randomUUID(),
    number: 1,
    organizationId: org,
    ownerId: owner,
    workspaceId: null,
    content,
    facts,
    digest: `sha256:${'0'.repeat(64)}`,
    createdAt: from,
    createdBy: owner,
  };
}
const base = (patch: Partial<InvestmentBaseline> = {}) =>
  rev({
    kind: 'baseline',
    key: 'analysis',
    title: '报告',
    taskType: '运营',
    unit: '份',
    minutesPerUnit: 120,
    hourlyRateMinor: 12000,
    currency: 'CNY',
    source: '人工实测',
    ...patch,
  });
function sample(
  b = base(),
  patch: Partial<InvestmentWork> = {},
  available = true,
) {
  return {
    revision: rev({
      kind: 'work',
      key: randomUUID(),
      title: '报告',
      units: 1,
      sourceRunIds: [randomUUID()],
      sourceVersionId: randomUUID(),
      baselineRevisionId: b.id,
      adoptedAt: from,
      humanMinutes: 30,
      humanScope: 'complete',
      source: '员工确认',
      ...patch,
    }),
    baseline: b,
    sourceAvailable: available,
  };
}
const cost = (
  patch: Partial<InvestmentStatement> = {},
  facts: Record<string, unknown> = {},
) =>
  rev(
    {
      kind: 'statement',
      title: '投入',
      from,
      to,
      currency: 'CNY',
      modelMinor: 3000,
      otherMinor: 2000,
      subscriptionKnown: true,
      subscriptionRevisionIds: [],
      coverage: 'complete',
      standardHours: 160,
      source: '费用账单',
      ...patch,
    },
    facts,
  );
function report(
  samples: Parameters<typeof estimateInvestment>[0]['samples'] = [sample()],
  statements = [cost()],
  overrides: Partial<Parameters<typeof estimateInvestment>[0]> = {},
) {
  return InvestmentReportSchema.parse(
    estimateInvestment({
      organizationId: org,
      period: { from, to, timeZone: 'Asia/Shanghai' },
      samples,
      candidateWorks: samples.length,
      statements,
      filtered: false,
      generatedAt: from,
      ...overrides,
    }),
  );
}
describe('evidence-based savings (no inferred adoption or money)', () => {
  it('reproduces positive and negative adopted business units, 75 minutes / 150 CNY / 50 CNY cost', () => {
    const r = report([
      sample(),
      sample(base({ minutesPerUnit: 45 }), { humanMinutes: 60 }),
    ]);
    expect(r.savedMinutes).toBe(75);
    expect(r.groups[0]).toMatchObject({
      valueMinor: 15000,
      costMinor: 5000,
      ratio: 3,
      roi: 2,
      valueCoverage: 'complete',
    });
    expect(r.hoursEquivalent).toBe(75 / 60 / 160);
  });
  it('keeps negative savings and negative ROI', () => {
    expect(
      report([sample(base({ minutesPerUnit: 15 }))]).groups[0],
    ).toMatchObject({ valueMinor: -3000, ratio: -0.6, roi: -1.6 });
  });
  it('does not label a partial monetary value as full ROI when an unpriced sample is negative', () => {
    const r = report([
      sample(),
      sample(
        base({ hourlyRateMinor: null, currency: null, minutesPerUnit: 0 }),
        { humanMinutes: 120 },
      ),
    ]);
    expect(r.savedMinutes).toBe(-30);
    expect(r.groups[0]).toMatchObject({
      valueMinor: 18000,
      unvaluedWorks: 1,
      valueCoverage: 'partial',
      costCoverage: 'complete',
      ratio: null,
      roi: null,
    });
  });
  it('distinguishes explicit zero human input from unknown', () => {
    expect(report([sample(base(), { humanMinutes: 0 })]).savedMinutes).toBe(
      120,
    );
    expect(
      report([sample(base(), { humanMinutes: null })]).savedMinutes,
    ).toBeNull();
  });
  it.each([
    'not_adopted',
    'baseline_missing',
    'human_scope_incomplete',
    'source_unavailable',
  ] as const)('excludes %s with an explicit reason', (reason) => {
    const s = sample();
    if (reason === 'not_adopted')
      s.revision.content = {
        ...(s.revision.content as InvestmentWork),
        adoptedAt: null,
      };
    if (reason === 'human_scope_incomplete')
      s.revision.content = {
        ...(s.revision.content as InvestmentWork),
        humanScope: 'review_only',
      };
    const r = report([
      {
        ...s,
        baseline: reason === 'baseline_missing' ? null : s.baseline,
        sourceAvailable: reason !== 'source_unavailable',
      },
    ] as Parameters<typeof estimateInvestment>[0]['samples']);
    expect(r.includedWorks).toBe(0);
    expect(r.missing[reason]).toBe(1);
    expect(r.groups[0]?.roi).toBeNull();
  });
  it('requires rate and currency together', () => {
    expect(
      InvestmentContentSchema.safeParse({ ...base().content, currency: null })
        .success,
    ).toBe(false);
  });
  it('preserves unknown costs instead of zero', () => {
    expect(
      report(undefined, [cost({ modelMinor: null })]).groups[0],
    ).toMatchObject({
      modelMinor: null,
      costMinor: null,
      costCoverage: 'unknown',
      roi: null,
    });
  });
  it('allows a confirmed zero cost but never divides by zero', () => {
    expect(
      report(undefined, [cost({ modelMinor: 0, otherMinor: 0 })]).groups[0],
    ).toMatchObject({ costMinor: 0, costCoverage: 'complete', roi: null });
  });
  it('does not call partial declarations complete', () => {
    expect(
      report(undefined, [cost({ coverage: 'partial' })]).groups[0],
    ).toMatchObject({ costCoverage: 'partial', roi: null });
  });
  it('does not compare filtered savings against entire company cost', () => {
    expect(
      report(undefined, undefined, { filtered: true }).groups[0],
    ).toMatchObject({ costCoverage: 'partial', roi: null });
  });
  it('matches exact period instants', () => {
    expect(
      report(undefined, [cost({ to: '2026-11-02T00:00:00Z' })]).groups[0],
    ).toMatchObject({ statement: null, costMinor: null });
    expect(
      report(undefined, [cost({ from: '2026-10-01T08:00:00+08:00' })]).groups[0]
        ?.ratio,
    ).toBe(3.6);
  });
  it('keeps currencies separate', () => {
    const r = report(
      [sample(), sample(base({ currency: 'USD' }))],
      [cost(), cost({ currency: 'USD' })],
    );
    expect(r.groups.map((g) => [g.currency, g.valueMinor])).toEqual([
      ['CNY', 18000],
      ['USD', 18000],
    ]);
  });
  it('uses frozen subscription allocations', () => {
    expect(
      report(undefined, [
        cost({}, { subscriptionReferences: [{ amountMinor: 3600 }] }),
      ]).groups[0]?.costMinor,
    ).toBe(8600);
  });
  it('does not expose a full total if evidence exceeds the cap', () => {
    expect(
      report(undefined, undefined, { candidateWorks: 1001 }),
    ).toMatchObject({ truncated: true, savedMinutes: null });
    expect(
      report(undefined, undefined, { candidateWorks: 1001 }).groups[0]?.roi,
    ).toBeNull();
  });
  it('requires a configured unique hours denominator', () => {
    expect(
      report(undefined, [cost({ standardHours: null })]).hoursEquivalent,
    ).toBeNull();
    expect(
      report(undefined, [cost(), cost({ currency: 'USD', standardHours: 150 })])
        .standardHours,
    ).toBeNull();
  });
  it('refuses duplicate samples and inconsistent denominator', () => {
    const s = sample();
    expect(() => report([s, s])).toThrow();
    expect(() => report(undefined, undefined, { candidateWorks: 0 })).toThrow();
  });
  it('never treats no evidence as a zero benefit', () => {
    const r = report([], []);
    expect(r).toMatchObject({
      candidateWorks: 0,
      includedWorks: 0,
      savedMinutes: null,
      groups: [],
    });
  });
  it('validates explicit adoption, allocation envelopes and unique receipt references', () => {
    expect(
      InvestmentContentSchema.safeParse({
        ...sample().revision.content,
        sourceVersionId: null,
      }).success,
    ).toBe(false);
    expect(
      InvestmentContentSchema.safeParse({
        kind: 'expense',
        receiptKey: 'a',
        title: 'a',
        from,
        to,
        currency: 'CNY',
        amountMinor: 1,
        allocations: [{ organizationId: org, amountMinor: 2 }],
        source: 'bill',
      }).success,
    ).toBe(false);
    const id = randomUUID();
    expect(
      InvestmentContentSchema.safeParse({
        ...cost().content,
        subscriptionRevisionIds: [id, id],
      }).success,
    ).toBe(false);
  });
});
