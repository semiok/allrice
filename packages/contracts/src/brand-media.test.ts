import {
  brandMediaTools,
  BrandMediaCandidatesResultSchema,
  BrandMediaArticleResultSchema,
} from './brand-media-tools.ts';
import {
  brandMediaModuleV010,
  brandMediaModule,
  brandMediaRelease,
  brandMediaUsage,
} from './brand-media-module.ts';
import {
  EmployeeExecutionSnapshotV1Schema,
  EmployeeExecutionSnapshotV2Schema,
} from './employees.ts';
import {
  BrandMediaGenerateInputSchema,
  BrandMediaInvocationSchema,
} from './brand-media.ts';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BrandMediaArticleSchema,
  BrandMediaArticleSubmissionSchema,
  BrandMediaImagesSchema,
  BrandMediaPublicationSchema,
  BrandMediaReadInputSchema,
  BrandMediaReadResultSchema,
  BrandMediaReferenceSchema,
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

describe('P3 exact module contracts', () => {
  it('keeps generated file pins versioned and accepts only immutable upload object/checksum nominations', () => {
    const upload = {
      origin: 'upload',
      file: { objectId: file.objectId, checksum: file.checksum },
    };
    expect(BrandMediaReferenceSchema.parse(upload)).toEqual(upload);
    expect(
      BrandMediaReferenceSchema.safeParse({ ...upload, file }).success,
    ).toBe(false);
    expect(
      BrandMediaReferenceSchema.safeParse({ origin: 'file', file: upload.file })
        .success,
    ).toBe(false);
    expect(
      BrandMediaReferenceSchema.safeParse({ ...upload, ownerId: id(1) })
        .success,
    ).toBe(false);
  });
  it('keeps old snapshot fields absent, publishes a new exact release and signs one user guide resource', () => {
    expect(EmployeeExecutionSnapshotV1Schema.shape).not.toHaveProperty(
      'modules',
    );
    expect(EmployeeExecutionSnapshotV1Schema.shape).not.toHaveProperty(
      'moduleInvocation',
    );
    expect(
      EmployeeExecutionSnapshotV2Schema.shape.modules.parse(undefined),
    ).toBeUndefined();
    expect(
      EmployeeExecutionSnapshotV2Schema.shape.moduleInvocation.parse(undefined),
    ).toBeUndefined();
    expect(brandMediaModuleV010).toMatchObject({
      contentVersion: '0.1.0',
      tools: [],
      skills: [],
      views: [],
    });
    expect(brandMediaRelease.contentVersion).toBe('0.3.0');
    expect(brandMediaRelease.digest).not.toBe(brandMediaModuleV010.digest);
    expect(brandMediaModule.tools).toEqual(
      brandMediaTools.map((entry) => entry.canonicalName),
    );
    expect(brandMediaUsage.checksum).toBe(
      'sha256:' +
        createHash('sha256').update(brandMediaUsage.content).digest('hex'),
    );
    expect(brandMediaUsage.content).not.toMatch(/workspace\.|CAS|P3|P4/);
  });
  it('browser intents exclude trusted facts, runtime controls and body submission', () => {
    const intent = {
      ...scope,
      requestId: id(5),
      operation: 'candidates',
      direction: '想几个新品选题',
      references: [],
    };
    expect(BrandMediaGenerateInputSchema.parse(intent)).toEqual(intent);
    for (const facts of [
      { module: brandMediaRelease },
      { moduleInvocation: {} },
      { deliveryMode: 'steer' },
      { organizationId: id(9) },
      { enabled: true },
      { body: '伪造正文' },
    ])
      expect(
        BrandMediaGenerateInputSchema.safeParse({ ...intent, ...facts })
          .success,
      ).toBe(false);
    expect(BrandMediaInvocationSchema.safeParse({ intent }).success).toBe(
      false,
    );
  });
  it('keeps every old version pin strict and admits only a tagged immutable upload image nomination', () => {
    const upload = {
      source: 'uploaded',
      origin: 'upload',
      file: { objectId: file.objectId, checksum: file.checksum },
    };
    expect(BrandMediaImagesSchema.parse([upload])).toEqual([upload]);
    for (const image of [
      { source: 'uploaded', file: upload.file },
      { ...upload, source: 'generated', operationId: id(8) },
      { ...upload, operationId: id(8) },
      { ...upload, file },
      { file: upload.file, source: 'generated', operationId: id(8) },
    ])
      expect(BrandMediaImagesSchema.safeParse([image]).success).toBe(false);
    expect(
      BrandMediaImagesSchema.safeParse([upload, { source: 'uploaded', file }])
        .success,
    ).toBe(false);
    const remove = {
      ...command,
      operation: 'article.image.remove',
      upload: upload.file,
    };
    expect(BrandMediaUserCommandSchema.parse(remove)).toEqual(remove);
    expect(
      BrandMediaUserCommandSchema.parse({
        ...command,
        operation: 'article.image.remove',
        versionId: file.versionId,
      }),
    ).toMatchObject({ versionId: file.versionId });
    for (const patch of [
      { versionId: file.versionId },
      { objectId: file.objectId },
      { upload: { objectId: file.objectId } },
    ])
      expect(
        BrandMediaUserCommandSchema.safeParse({ ...remove, ...patch }).success,
      ).toBe(false);
    expect(
      BrandMediaArticleSubmissionSchema.safeParse({
        ...command,
        title: '正文',
        body: upload.file,
      }).success,
    ).toBe(false);
  });
  it('freezes one description and target for image generation, with no references, edit source or browser authority', () => {
    const intent = {
      ...command,
      operation: 'image',
      description: '暖光下的冬日门店',
    };
    expect(BrandMediaGenerateInputSchema.parse(intent)).toEqual(intent);
    expect(
      BrandMediaGenerateInputSchema.parse({ ...intent, retryOfRunId: id(10) }),
    ).toMatchObject({ retryOfRunId: id(10) });
    for (const patch of [
      { references: [] },
      { source: file },
      { count: 2 },
      { imageModel: 'auto' },
      { module: brandMediaRelease },
      { humanSource: true },
      { description: '' },
      { description: 'x'.repeat(4001) },
    ])
      expect(
        BrandMediaGenerateInputSchema.safeParse({ ...intent, ...patch })
          .success,
      ).toBe(false);
    expect(
      BrandMediaGenerateInputSchema.safeParse({
        ...intent,
        articleId: undefined,
      }).success,
    ).toBe(false);
  });
  it('models nominate text only and actual immutable delivery receipts have a strict success/conflict contract', () => {
    const candidate = {
      candidates: [{ title: '新品故事', summary: '真实规格' }],
    };
    expect(BrandMediaCandidatesResultSchema.safeParse(candidate).success).toBe(
      false,
    );
    const receipt = { ...candidate, file, runId: id(5), addedToTopics: false };
    expect(BrandMediaCandidatesResultSchema.parse(receipt)).toEqual(receipt);
    expect(brandMediaTools[1].input.safeParse(receipt).success).toBe(false);
    expect(
      BrandMediaArticleResultSchema.safeParse({
        articleUpdated: false,
        file,
        runId: id(5),
        conflict: 'version_conflict',
      }).success,
    ).toBe(true);
    expect(
      BrandMediaArticleResultSchema.safeParse({
        articleUpdated: true,
        file,
        runId: id(5),
      }).success,
    ).toBe(false);
    expect(
      brandMediaTools[2].input.safeParse({
        articleId: id(6),
        expectedRevision: 1,
        title: '标题',
        body: '正文',
        ownerId: id(7),
      }).success,
    ).toBe(false);
  });
});
