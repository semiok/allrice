import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { BrandContentVersionRefSchema } from './brand-content.ts';

// MET-224 s1.3. Business data only: no Run lifecycle or tool registration.
const id = UuidSchema.transform((value) => value.toLowerCase());
const revision = z.number().int().positive();
const text = (max: number) => z.string().trim().min(1).max(max);
export const BrandMediaScopeSchema = z
  .object({ workspaceId: id, instanceId: id })
  .strict();
export const BrandMediaFileSchema = BrandContentVersionRefSchema.extend({
  objectId: id,
  versionId: id,
});
/** A nominated exact revision, never a grant. Resolve current ACLs on each use. */
export const BrandMediaReferenceSchema = z.discriminatedUnion('origin', [
  z
    .object({ origin: z.literal('reference'), sourceId: id, revisionId: id })
    .strict(),
  z.object({ origin: z.literal('file'), file: BrandMediaFileSchema }).strict(),
]);
export const BrandMediaReferencesSchema = z
  .array(BrandMediaReferenceSchema)
  .superRefine((values, ctx) => {
    const keys = values.map((value) =>
      value.origin === 'reference'
        ? `reference:${value.sourceId}`
        : `file:${value.file.objectId}`,
    );
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Reference sources must be distinct.',
      });
  });
export const BrandMediaCandidateSchema = z
  .object({ title: text(240), summary: text(2000) })
  .strict();
export const BrandMediaImageSchema = z
  .object({
    file: BrandMediaFileSchema,
    source: z.enum(['uploaded', 'generated']),
    operationId: id.optional(),
  })
  .strict()
  .refine((image) => (image.source === 'generated') === !!image.operationId, {
    message: 'Only generated images carry the existing image operation ID.',
  });
export const BrandMediaImagesSchema = z
  .array(BrandMediaImageSchema)
  .refine(
    (images) =>
      new Set(images.map((image) => image.file.objectId)).size ===
      images.length,
    'Images must be distinct; array order is display order and the first is the cover.',
  );
const timezone = text(64).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Choose an IANA timezone');
export const BrandMediaScheduleSchema = z
  .object({ plannedAt: TimestampSchema, timezone })
  .strict();
const publishedUrl = z.url({ protocol: /^https?$/ });
export const BrandMediaPublishedLinksSchema = z
  .object({
    wechat: publishedUrl.nullable(),
    xiaohongshu: publishedUrl.nullable(),
  })
  .strict();
export const BrandMediaStateSchema = z.enum([
  'draft',
  'scheduled',
  'published',
]);
export const BrandMediaPublicationSchema = z.discriminatedUnion('state', [
  z
    .object({ state: z.literal('draft'), schedule: z.null(), links: z.null() })
    .strict(),
  z
    .object({
      state: z.literal('scheduled'),
      schedule: BrandMediaScheduleSchema,
      links: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal('published'),
      schedule: BrandMediaScheduleSchema,
      links: BrandMediaPublishedLinksSchema,
    })
    .strict(),
]);
const record = {
  ...BrandMediaScopeSchema.shape,
  id,
  revision,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
};
/** Only user-selected candidates become topics. Generated candidates stay in Run results. */
export const BrandMediaTopicSchema = z
  .object({
    ...record,
    candidate: BrandMediaCandidateSchema,
    direction: text(8000),
    references: BrandMediaReferencesSchema,
    sourceRunId: id,
  })
  .strict();
export const BrandMediaArticleSchema = z
  .object({
    ...record,
    topicId: id,
    title: text(240),
    requirements: z.string().trim().max(8000),
    body: BrandMediaFileSchema.nullable(),
    references: BrandMediaReferencesSchema,
    images: BrandMediaImagesSchema,
    publication: BrandMediaPublicationSchema,
  })
  .strict();

// Public commands nominate objects. Actor, organization, module binding, message,
// Run lease and permissions must come from the trusted entrypoint in P3.
const command = { ...BrandMediaScopeSchema.shape, requestId: id };
const topicCommand = { ...command, topicId: id, expectedRevision: revision };
const articleCommand = {
  ...command,
  articleId: id,
  expectedRevision: revision,
};
export const BrandMediaPublicationChangeSchema = z.discriminatedUnion(
  'action',
  [
    z
      .object({
        action: z.literal('schedule'),
        schedule: BrandMediaScheduleSchema,
      })
      .strict(),
    z.object({ action: z.literal('unschedule') }).strict(),
    z
      .object({
        action: z.literal('publish'),
        links: BrandMediaPublishedLinksSchema,
      })
      .strict(),
    z.object({ action: z.literal('unpublish') }).strict(),
  ],
);
export const BrandMediaUserCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...command,
      operation: z.literal('topic.add'),
      candidate: BrandMediaCandidateSchema,
      direction: text(8000),
      references: BrandMediaReferencesSchema,
      sourceRunId: id,
    })
    .strict(),
  z.object({ ...topicCommand, operation: z.literal('topic.delete') }).strict(),
  z
    .object({
      ...topicCommand,
      operation: z.literal('article.start'),
      requirements: z.string().trim().max(8000),
      references: BrandMediaReferencesSchema,
    })
    .strict(),
  z
    .object({
      ...articleCommand,
      operation: z.literal('article.publication'),
      change: BrandMediaPublicationChangeSchema,
    })
    .strict(),
  z
    .object({
      ...articleCommand,
      operation: z.literal('article.references'),
      references: BrandMediaReferencesSchema,
    })
    .strict(),
  z
    .object({
      ...articleCommand,
      operation: z.literal('article.image.add'),
      image: BrandMediaImageSchema,
    })
    .strict(),
  z
    .object({
      ...articleCommand,
      operation: z.literal('article.image.remove'),
      versionId: id,
    })
    .strict(),
  z
    .object({ ...articleCommand, operation: z.literal('article.delete') })
    .strict(),
]);
/** Worker result shape, not a browser command or an implemented tool. */
export const BrandMediaArticleSubmissionSchema = z
  .object({ ...articleCommand, title: text(240), body: BrandMediaFileSchema })
  .strict();
/** Publishing is manual business progress, unrelated to native scheduling. */
export function transitionBrandMediaPublication(
  current: BrandMediaPublication,
  change: BrandMediaPublicationChange,
): BrandMediaPublication {
  current = BrandMediaPublicationSchema.parse(current);
  change = BrandMediaPublicationChangeSchema.parse(change);
  switch (change.action) {
    case 'schedule':
      if (current.state !== 'published')
        return { state: 'scheduled', schedule: change.schedule, links: null };
      break;
    case 'unschedule':
      if (current.state === 'scheduled')
        return { state: 'draft', schedule: null, links: null };
      break;
    case 'publish':
      if (current.state === 'scheduled')
        return {
          state: 'published',
          schedule: current.schedule,
          links: change.links,
        };
      break;
    case 'unpublish':
      if (current.state === 'published')
        return { state: 'scheduled', schedule: current.schedule, links: null };
  }
  throw new Error('brand_media_invalid_transition');
}

const cursor = z.object({ createdAt: TimestampSchema, id }).strict();
export const BrandMediaReadInputSchema = z.discriminatedUnion('view', [
  z
    .object({
      ...BrandMediaScopeSchema.shape,
      view: z.literal('topics'),
      cursor: cursor.optional(),
    })
    .strict(),
  z
    .object({
      ...BrandMediaScopeSchema.shape,
      view: z.literal('articles'),
      state: BrandMediaStateSchema.optional(),
      cursor: cursor.optional(),
    })
    .strict(),
  z
    .object({
      ...BrandMediaScopeSchema.shape,
      view: z.literal('article'),
      articleId: id,
    })
    .strict(),
  z
    .object({
      ...BrandMediaScopeSchema.shape,
      view: z.literal('calendar'),
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      timezone,
    })
    .strict(),
]);
export const BrandMediaReadResultSchema = z.discriminatedUnion('view', [
  z
    .object({
      view: z.literal('topics'),
      items: z.array(BrandMediaTopicSchema),
      nextCursor: cursor.nullable(),
    })
    .strict(),
  z
    .object({
      view: z.literal('articles'),
      items: z.array(BrandMediaArticleSchema),
      nextCursor: cursor.nullable(),
    })
    .strict(),
  z
    .object({ view: z.literal('article'), article: BrandMediaArticleSchema })
    .strict(),
  // A complete local calendar month, never the first page of the articles list.
  z
    .object({
      view: z.literal('calendar'),
      items: z
        .array(BrandMediaArticleSchema)
        .refine((items) =>
          items.every((item) => item.publication.state !== 'draft'),
        ),
    })
    .strict(),
]);
export const BrandMediaMutationResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('topic'), topic: BrandMediaTopicSchema }).strict(),
  z
    .object({ kind: z.literal('article'), article: BrandMediaArticleSchema })
    .strict(),
  z.object({ kind: z.literal('deleted'), id }).strict(),
]);
export type BrandMediaPublication = z.infer<typeof BrandMediaPublicationSchema>;
export type BrandMediaPublicationChange = z.infer<
  typeof BrandMediaPublicationChangeSchema
>;
export type BrandMediaUserCommand = z.infer<typeof BrandMediaUserCommandSchema>;
export type BrandMediaArticleSubmission = z.infer<
  typeof BrandMediaArticleSubmissionSchema
>;
export type BrandMediaTopic = z.infer<typeof BrandMediaTopicSchema>;
export type BrandMediaArticle = z.infer<typeof BrandMediaArticleSchema>;
export type BrandMediaReadInput = z.infer<typeof BrandMediaReadInputSchema>;
export type BrandMediaReadResult = z.infer<typeof BrandMediaReadResultSchema>;
export type BrandMediaMutationResult = z.infer<
  typeof BrandMediaMutationResultSchema
>;
