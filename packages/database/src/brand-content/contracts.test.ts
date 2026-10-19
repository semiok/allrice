import { describe, expect, it } from 'vitest';
import {
  BrandContentActionSchema,
  BrandContextContentSchema,
  RegisterBrandContentReminderSchema,
} from '../../../contracts/src/brand-content.ts';
import {
  assertBrandContentAuthority,
  assertBrandContentApprovedBundle,
  assertBrandContentParent,
  assertBrandRevision,
  brandContentDigest,
  brandContentBundleDigest,
  mergeBrandContentImages,
  normalizeBrandTopicTitle,
} from './rules.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const checksum = 'sha256:' + 'a'.repeat(64);
const base = {
  workspaceId: id(1),
  instanceId: id(2),
  requestId: 'a-real-retry-key',
};
const context = {
  audience: '纸笔用户',
  tone: '具体温和',
  requirements: '仅使用给定事实',
  facts: [{ id: 'size', text: 'A5' }],
};
const workflow = { workflowRevisionId: id(3), packageDigest: checksum };
const file = { objectId: id(4), versionId: id(5), checksum };
const image = {
  slotKey: 'cover',
  file,
  sourceKind: 'uploaded' as const,
  caption: '',
};

describe('brand content strict inputs and authority', () => {
  it('admits only actual completed message evidence for a no-Run reminder and keeps package selection out of registration raw', () => {
    const delivered = {
      ...base,
      brandId: id(6),
      planId: id(7),
      expectedRevision: 2,
      operation: 'plan.reminder',
      status: 'reminded',
      automationId: id(8),
      automationRunId: id(9),
      deliveryMessageId: id(10),
    };
    expect(BrandContentActionSchema.safeParse(delivered).success).toBe(true);
    expect(
      BrandContentActionSchema.safeParse({ ...delivered, runId: id(11) })
        .success,
    ).toBe(false);
    expect(
      BrandContentActionSchema.safeParse({ ...delivered, status: 'registered' })
        .success,
    ).toBe(false);
    expect(
      BrandContentActionSchema.safeParse({ ...delivered, status: 'failed' })
        .success,
    ).toBe(false);
    const register = {
      ...base,
      brandId: id(6),
      planId: id(7),
      expectedRevision: 1,
    };
    expect(RegisterBrandContentReminderSchema.safeParse(register).success).toBe(
      true,
    );
    expect(
      RegisterBrandContentReminderSchema.safeParse({ ...register, workflow })
        .success,
    ).toBe(false);
    expect(
      RegisterBrandContentReminderSchema.safeParse({
        ...register,
        authority: 'scheduler',
      }).success,
    ).toBe(false);
  });
  it('rejects caller supplied authority, org and owner fields', () => {
    const input = {
      ...base,
      operation: 'context.save',
      expectedRevision: 0,
      name: '演示',
      content: context,
    };
    for (const extra of [
      { authority: 'user' },
      { organizationId: id(9) },
      { ownerId: id(9) },
    ])
      expect(
        BrandContentActionSchema.safeParse({ ...input, ...extra }).success,
      ).toBe(false);
  });
  it('rejects duplicate fact identifiers and invented image operation provenance', () => {
    expect(
      BrandContextContentSchema.safeParse({
        ...context,
        facts: [...context.facts, ...context.facts],
      }).success,
    ).toBe(false);
    expect(
      BrandContentActionSchema.safeParse({
        ...base,
        operation: 'article.images',
        brandId: id(6),
        articleId: id(7),
        expectedRevision: 1,
        bundleDigest: checksum,
        images: [{ ...image, sourceKind: 'generated' }],
        changeSummary: '重做',
      }).success,
    ).toBe(false);
  });
  it.each(['topics.decide', 'article.review', 'receipt.record'] as const)(
    'workflow cannot impersonate human %s',
    (operation) => {
      expect(() =>
        assertBrandContentAuthority(
          { operation, workflow } as never,
          'workflow',
        ),
      ).toThrow('authority_denied');
    },
  );
  it('requires exact workflow pins and scheduler-only reminder evidence', () => {
    expect(() =>
      assertBrandContentAuthority(
        { operation: 'topics.propose' } as never,
        'workflow',
      ),
    ).toThrow('workflow_pin_required');
    expect(() =>
      assertBrandContentAuthority(
        { operation: 'plan.reminder' } as never,
        'user',
      ),
    ).toThrow('authority_denied');
    expect(() =>
      assertBrandContentAuthority(
        { operation: 'plan.save' } as never,
        'scheduler',
      ),
    ).toThrow('authority_denied');
    expect(
      BrandContentActionSchema.safeParse({
        ...base,
        operation: 'plan.reminder',
        brandId: id(6),
        planId: id(7),
        expectedRevision: 1,
        status: 'reminded',
        automationId: id(8),
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate selected IDs, invalid timezone and placeholder receipt', () => {
    expect(
      BrandContentActionSchema.safeParse({
        ...base,
        operation: 'topics.decide',
        brandId: id(6),
        batchId: id(7),
        expectedRevision: 1,
        choices: [
          { topicId: id(8), decision: 'accepted' },
          { topicId: id(8), decision: 'rejected' },
        ],
      }).success,
    ).toBe(false);
    const plan = {
      ...base,
      operation: 'plan.save',
      brandId: id(6),
      articleId: id(7),
      expectedRevision: 0,
      bundleDigest: checksum,
      reviewId: id(8),
      platform: '小红书',
      plannedAt: '2026-10-21T12:30:00+08:00',
      timezone: 'Mars/Base',
      publisher: 'snow',
    };
    expect(BrandContentActionSchema.safeParse(plan).success).toBe(false);
    const receipt = {
      ...base,
      operation: 'receipt.record',
      brandId: id(6),
      planId: id(7),
      expectedRevision: 1,
      bundleDigest: checksum,
      platform: '小红书',
      publisher: 'snow',
      publishedUrl: 'https://example.com/post',
      actualPublishedAt: '2026-10-19T12:30:00+08:00',
      sourceType: 'manual_confirmation',
      evidence: '人工录入',
    };
    expect(BrandContentActionSchema.safeParse(receipt).success).toBe(false);
    expect(
      BrandContentActionSchema.safeParse({
        ...receipt,
        publishedUrl: 'https://mp.weixin.qq.com/s/actual-post-reference',
        verificationState: 'checked',
      }).success,
    ).toBe(false);
  });
});
describe('brand content version and source boundaries', () => {
  it('deduplicates normalized titles without erasing a different content angle', () => {
    expect(normalizeBrandTopicTitle('Ａ５：今天的三件小事！')).toBe(
      normalizeBrandTopicTitle('A5 今天的三件小事'),
    );
    expect(normalizeBrandTopicTitle('今天的三件小事')).not.toBe(
      normalizeBrandTopicTitle('明天的三件小事'),
    );
    expect(() => normalizeBrandTopicTitle('！？')).toThrow(
      'source_reference_invalid',
    );
  });
  it('has stable canonical request digests and distinguishes changed inputs', () => {
    expect(brandContentDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      brandContentDigest({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(brandContentDigest({ a: 1 })).not.toBe(brandContentDigest({ a: 2 }));
    expect(brandContentDigest({ authority: 'user' })).not.toBe(
      brandContentDigest({ authority: 'workflow' }),
    );
  });
  it('single-slot replacement preserves untouched images and changes the reviewed bundle', () => {
    const detail = { ...image, slotKey: 'detail' },
      replacement = { ...image, file: { ...file, objectId: id(10) } };
    const patched = mergeBrandContentImages([image, detail], [replacement], []);
    expect(patched).toHaveLength(2);
    expect(patched.find((x) => x.slotKey === 'detail')).toEqual(detail);
    expect(brandContentBundleDigest('小红书', file, patched)).not.toBe(
      brandContentBundleDigest('小红书', file, [image, detail]),
    );
    expect(brandContentBundleDigest('小红书', file, [detail, image])).toBe(
      brandContentBundleDigest('小红书', file, [image, detail]),
    );
    expect(() => mergeBrandContentImages([image], [], ['absent'])).toThrow(
      'source_reference_invalid',
    );
  });
  it('requires the actual exact parent and fresh optimistic revision', () => {
    expect(() =>
      assertBrandContentParent(id(5), id(5), {
        versionId: id(11),
        parentVersionId: id(5),
      }),
    ).not.toThrow();
    expect(() =>
      assertBrandContentParent(id(5), id(5), {
        versionId: id(11),
        parentVersionId: id(12),
      }),
    ).toThrow('parent_mismatch');
    expect(() =>
      assertBrandContentParent(id(5), id(5), {
        versionId: id(5),
        parentVersionId: id(5),
      }),
    ).toThrow('parent_mismatch');
    expect(() => assertBrandRevision(3, 2)).toThrow('version_conflict');
  });
  it('never schedules a revised or unapproved bundle under an old review', () => {
    const article = { id: id(7), state: 'approved', platform: '小红书' };
    const bundle = { id: id(8), digest: checksum };
    const review = {
      article_id: article.id,
      bundle_id: bundle.id,
      bundle_digest: checksum,
      decision: 'approved',
    };
    const input = { bundleDigest: checksum, platform: article.platform };
    expect(() =>
      assertBrandContentApprovedBundle(article, bundle, review, input),
    ).not.toThrow();
    for (const bad of [
      { ...review, bundle_id: id(9) },
      { ...review, article_id: id(9) },
      { ...review, decision: 'rejected' },
    ])
      expect(() =>
        assertBrandContentApprovedBundle(article, bundle, bad, input),
      ).toThrow('invalid_state');
    expect(() =>
      assertBrandContentApprovedBundle(
        { ...article, state: 'awaiting_review' },
        bundle,
        review,
        input,
      ),
    ).toThrow('invalid_state');
    expect(() =>
      assertBrandContentApprovedBundle(article, bundle, review, {
        ...input,
        bundleDigest: 'sha256:' + 'b'.repeat(64),
      }),
    ).toThrow('invalid_state');
  });
});
