import { describe, expect, it } from 'vitest';
import {
  BrandMediaArticleSchema,
  BrandMediaArticleSubmissionSchema,
  BrandMediaImagesSchema,
  BrandMediaPublicationSchema,
  BrandMediaReadInputSchema,
  BrandMediaReadResultSchema,
  BrandMediaReferencesSchema,
  BrandMediaUserCommandSchema,
  transitionBrandMediaPublication,
  type BrandMediaPublication,
  type BrandMediaPublicationChange,
} from './brand-media.ts';

const id = (n: number) =>
  `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { workspaceId: id(1), instanceId: id(2) };
const file = {
  objectId: id(3),
  versionId: id(4),
  checksum: `sha256:${'a'.repeat(64)}`,
};
const schedule = {
  plannedAt: '2026-11-24T20:00:00+08:00',
  timezone: 'Asia/Shanghai',
};
const links = { wechat: null, xiaohongshu: null };
const draft: BrandMediaPublication = {
  state: 'draft',
  schedule: null,
  links: null,
};
const scheduled: BrandMediaPublication = {
  state: 'scheduled',
  schedule,
  links: null,
};
const published: BrandMediaPublication = {
  state: 'published',
  schedule,
  links,
};
const article = {
  ...scope,
  id: id(5),
  topicId: id(6),
  revision: 1,
  title: '这一年，谢谢你常来',
  requirements: '',
  body: null,
  references: [],
  images: [],
  publication: draft,
  createdAt: '2026-11-16T00:00:00Z',
  updatedAt: '2026-11-16T00:00:00Z',
};
const command = {
  ...scope,
  requestId: id(7),
  articleId: id(5),
  expectedRevision: 1,
};

describe('品牌自媒体 s1.3 data contract', () => {
  it('“排在周二晚上八点；发完了；刚才点错了，改回已排期” preserves time and clears links', () => {
    const planned = transitionBrandMediaPublication(draft, {
      action: 'schedule',
      schedule,
    });
    const sent = transitionBrandMediaPublication(planned, {
      action: 'publish',
      links: { ...links, wechat: 'https://mp.weixin.qq.com/s/example' },
    });
    expect(sent).toEqual({
      state: 'published',
      schedule,
      links: {
        wechat: 'https://mp.weixin.qq.com/s/example',
        xiaohongshu: null,
      },
    });
    const corrected = transitionBrandMediaPublication(sent, {
      action: 'unpublish',
    });
    expect(corrected).toEqual(scheduled);
    expect(
      transitionBrandMediaPublication(corrected, { action: 'unschedule' }),
    ).toEqual(draft);
    expect(sent.links?.wechat).toBe('https://mp.weixin.qq.com/s/example');
  });

  it('can change a scheduled time and publish without either platform link', () => {
    const next = { ...schedule, plannedAt: '2026-11-25T20:00:00+08:00' };
    const changed = transitionBrandMediaPublication(scheduled, {
      action: 'schedule',
      schedule: next,
    });
    expect(
      transitionBrandMediaPublication(changed, { action: 'publish', links }),
    ).toEqual({ state: 'published', schedule: next, links });
  });

  it.each<[BrandMediaPublication, BrandMediaPublicationChange]>([
    [draft, { action: 'publish', links }],
    [draft, { action: 'unpublish' }],
    [draft, { action: 'unschedule' }],
    [scheduled, { action: 'unpublish' }],
    [published, { action: 'publish', links }],
    [published, { action: 'unschedule' }],
    [published, { action: 'schedule', schedule }],
  ])(
    'rejects an unavailable action without modifying publication data',
    (current, change) => {
      const before = structuredClone(current);
      expect(() => transitionBrandMediaPublication(current, change)).toThrow(
        'brand_media_invalid_transition',
      );
      expect(current).toEqual(before);
    },
  );

  it('retains an empty draft after failed initial generation and a pinned body after failed revision', () => {
    expect(BrandMediaArticleSchema.parse(article).body).toBeNull();
    expect(
      BrandMediaArticleSchema.parse({ ...article, body: file }).body,
    ).toEqual(file);
    expect(
      BrandMediaArticleSchema.safeParse({
        ...article,
        publication: { ...draft, state: 'failed' },
      }).success,
    ).toBe(false);
  });

  it.each([
    { ...draft, schedule },
    { ...scheduled, schedule: null },
    { ...scheduled, links },
    { ...published, links: { ...links, wechat: 'javascript:alert(1)' } },
    { ...published, schedule: { ...schedule, timezone: 'Mars/Olympus' } },
    { ...published, actualPublishedAt: schedule.plannedAt },
  ])(
    'rejects contradictory progress and unsolicited publication fields',
    (value) => {
      expect(BrandMediaPublicationSchema.safeParse(value).success).toBe(false);
    },
  );

  it('separates browser actions from Worker body submission and trusted authorization', () => {
    expect(
      BrandMediaArticleSubmissionSchema.parse({
        ...command,
        title: article.title,
        body: file,
      }).body,
    ).toEqual(file);
    for (const operation of ['article.submit', 'article.body', 'tools.execute'])
      expect(
        BrandMediaUserCommandSchema.safeParse({
          ...command,
          operation,
          title: article.title,
          body: file,
        }).success,
      ).toBe(false);
    const input = {
      ...command,
      operation: 'article.publication',
      change: { action: 'publish', links },
    };
    expect(BrandMediaUserCommandSchema.safeParse(input).success).toBe(true);
    for (const extra of [
      { actor: 'user' },
      { organizationId: id(9) },
      { ownerId: id(9) },
      { moduleEnabled: true },
      { leaseToken: id(9) },
    ])
      expect(
        BrandMediaUserCommandSchema.safeParse({ ...input, ...extra }).success,
      ).toBe(false);
    expect(
      BrandMediaUserCommandSchema.safeParse({ ...input, expectedRevision: 0 })
        .success,
    ).toBe(false);
  });

  it('starts from an explicitly selected topic with fixed references and optional instructions', () => {
    const input = {
      ...scope,
      requestId: id(7),
      operation: 'article.start',
      topicId: id(6),
      expectedRevision: 1,
      requirements: '',
      references: [{ origin: 'file', file }],
    };
    expect(BrandMediaUserCommandSchema.parse(input)).toEqual(input);
    expect(
      BrandMediaUserCommandSchema.safeParse({ ...input, sourceRunId: id(8) })
        .success,
    ).toBe(false);
    const add = {
      ...scope,
      requestId: id(7),
      operation: 'topic.add',
      candidate: { title: '冬季通勤', summary: '面向通勤上班族' },
      direction: '介绍冬季新品',
      sourceRunId: id(8),
      references: [],
    };
    expect(BrandMediaUserCommandSchema.parse(add)).toEqual(add);
  });

  it('pins reference revisions and catches duplicates including UUID case variants', () => {
    const ref = { origin: 'reference', sourceId: id(10), revisionId: id(11) };
    expect(
      BrandMediaReferencesSchema.parse([ref, { origin: 'file', file }]),
    ).toHaveLength(2);
    expect(
      BrandMediaReferencesSchema.safeParse([
        ref,
        { ...ref, sourceId: ref.sourceId.toUpperCase(), revisionId: id(12) },
      ]).success,
    ).toBe(false);
    expect(
      BrandMediaReferencesSchema.safeParse([
        {
          origin: 'file',
          file: { objectId: file.objectId, checksum: file.checksum },
        },
      ]).success,
    ).toBe(false);
    expect(
      BrandMediaReferencesSchema.safeParse([{ ...ref, authorized: true }])
        .success,
    ).toBe(false);
  });

  it('keeps image order, exact versions and the provenance of generated images', () => {
    const images = [
      { file, source: 'uploaded' },
      {
        file: { ...file, objectId: id(12), versionId: id(13) },
        source: 'generated',
        operationId: id(14),
      },
    ];
    expect(BrandMediaImagesSchema.parse(images)).toEqual(images);
    expect(
      BrandMediaImagesSchema.safeParse([images[0], images[0]]).success,
    ).toBe(false);
    expect(
      BrandMediaImagesSchema.safeParse([{ file, source: 'generated' }]).success,
    ).toBe(false);
    expect(
      BrandMediaImagesSchema.safeParse([
        { file, source: 'uploaded', operationId: id(14) },
      ]).success,
    ).toBe(false);
  });

  it('separates complete calendar reads from paginated libraries', () => {
    expect(
      BrandMediaReadInputSchema.parse({
        ...scope,
        view: 'calendar',
        month: '2026-11',
        timezone: schedule.timezone,
      }).view,
    ).toBe('calendar');
    for (const month of ['2026-00', '2026-13', 'November', '2026-11-01'])
      expect(
        BrandMediaReadInputSchema.safeParse({
          ...scope,
          view: 'calendar',
          month,
          timezone: schedule.timezone,
        }).success,
      ).toBe(false);
    const items = Array.from({ length: 250 }, (_, n) => ({
      ...article,
      id: id(n + 100),
      publication: scheduled,
    }));
    expect(
      BrandMediaReadResultSchema.parse({ view: 'calendar', items }),
    ).toEqual({ view: 'calendar', items });
    expect(
      BrandMediaReadResultSchema.safeParse({
        view: 'calendar',
        items: [article],
      }).success,
    ).toBe(false);
    expect(
      BrandMediaReadResultSchema.safeParse({
        view: 'articles',
        items: [article],
      }).success,
    ).toBe(false);
    expect(
      BrandMediaReadResultSchema.parse({
        view: 'articles',
        items: [article],
        nextCursor: null,
      }).view,
    ).toBe('articles');
  });
});
