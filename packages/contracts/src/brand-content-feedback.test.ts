import { describe, expect, it } from 'vitest';
import {
  BrandFeedbackSchema,
  BrandFeedbackInputSchema,
  BrandPublicationUrlSchema,
  BrandRetrospectiveOutputSchema,
  BrandExperienceUsesSchema,
  summarizeBrandFeedback,
} from './brand-content-feedback.ts';

const id = '11111111-1111-4111-8111-111111111111';
const input = {
  contextRevisionId: id,
  publicationKind: 'imported_publication',
  title: 'Synthetic public-source test',
  platform: 'Bilibili',
  publishedUrl: 'https://www.bilibili.com/video/BV1synthetic/',
  publishedAt: '2026-01-01T00:00:00.000Z',
  sampledAt: '2026-01-02T00:00:00.000Z',
  sourceType: 'public_page',
  sourceUrl: 'https://api.bilibili.com/x/web-interface/view?bvid=synthetic',
  evidence: 'Synthetic values only.',
  limitations: 'No conversion or audience data available.',
  metrics: { views: null, likes: 0, comments: null, shares: null, saves: 2 },
};

describe('brand feedback evidence boundary', () => {
  it('preserves unknown versus observed zero and never invents a rate with an unknown or zero denominator', () => {
    const feedback = BrandFeedbackSchema.parse({
      ...input,
      id,
      digest: `sha256:${'a'.repeat(64)}`,
      createdAt: input.sampledAt,
    });
    expect(summarizeBrandFeedback([feedback])[0]).toEqual({
      feedbackId: id,
      knownMetrics: ['likes', 'saves'],
      unknownMetrics: ['views', 'comments', 'shares'],
      likesPerView: null,
    });
    feedback.metrics.views = 0;
    expect(summarizeBrandFeedback([feedback])[0]!.likesPerView).toBeNull();
    feedback.metrics.views = 100;
    expect(summarizeBrandFeedback([feedback])[0]!.likesPerView).toBe(0);
    feedback.metrics.likes = 3;
    expect(summarizeBrandFeedback([feedback])[0]!.likesPerView).toBe(0.03);
  });

  it('requires receipt linkage only for internal publications and valid measurement chronology', () => {
    expect(BrandFeedbackInputSchema.safeParse(input).success).toBe(true);
    for (const patch of [
      { publicationKind: 'receipt' },
      { receiptId: id },
      { sampledAt: '2025-12-31T00:00:00.000Z' },
      { metrics: { ...input.metrics, likes: -1 } },
      { metrics: { ...input.metrics, likes: 0.5 } },
      { metrics: { ...input.metrics, likes: Number.MAX_SAFE_INTEGER + 1 } },
    ])
      expect(
        BrandFeedbackInputSchema.safeParse({ ...input, ...patch }).success,
      ).toBe(false);
    expect(
      BrandFeedbackInputSchema.safeParse({
        ...input,
        publicationKind: 'receipt',
        receiptId: id,
      }).success,
    ).toBe(true);
  });

  it('requires public HTTPS source identifiers while accepting real numeric brand domains', () => {
    expect(
      BrandPublicationUrlSchema.safeParse('https://163.com/news').success,
    ).toBe(true);
    for (const url of [
      'http://www.bilibili.com/',
      'https://127.0.0.1/',
      'https://[::1]/',
      'https://2130706433/',
      'https://user:pass@bilibili.com/',
      'https://api.local/',
      'https://a.example.org/',
    ])
      expect(BrandPublicationUrlSchema.safeParse(url).success).toBe(false);
  });

  it('rejects duplicate or empty evidence and duplicate experience attributions', () => {
    const report = {
      summary: 'Summary',
      rule: 'Rule',
      applicability: 'Scope',
      limitations: 'Limits',
      feedbackIds: [id],
    };
    expect(BrandRetrospectiveOutputSchema.safeParse(report).success).toBe(true);
    for (const feedbackIds of [[], [id, id]])
      expect(
        BrandRetrospectiveOutputSchema.safeParse({ ...report, feedbackIds })
          .success,
      ).toBe(false);
    expect(
      BrandExperienceUsesSchema.safeParse([
        { id, reason: 'Used in opening' },
        { id, reason: 'Duplicate' },
      ]).success,
    ).toBe(false);
  });
});
