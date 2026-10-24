import { z } from 'zod';
import {
  BrandFeedbackInputSchema,
  BrandFeedbackSchema,
  BrandRetrospectiveOutputSchema,
  BrandRetrospectiveSchema,
  BrandExperienceSchema,
  BrandExperienceUsesSchema,
} from './brand-content-feedback.ts';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const revision = z.number().int().nonnegative();
export const BrandContentScopeSchema = z
  .object({ workspaceId: UuidSchema, instanceId: UuidSchema })
  .strict();
export const BrandContentFileRefSchema = z
  .object({
    objectId: UuidSchema,
    checksum: ChecksumSchema,
    versionId: UuidSchema.optional(),
  })
  .strict();
export const BrandContentVersionRefSchema = BrandContentFileRefSchema.extend({
  versionId: UuidSchema,
});
export const BrandContentWorkflowPinSchema = z
  .object({ workflowRevisionId: UuidSchema, packageDigest: ChecksumSchema })
  .strict();
export const BrandContextContentSchema = z
  .object({
    audience: text(2000),
    tone: text(2000),
    requirements: text(8000),
    visualBrief: z.string().trim().max(4000).default(''),
    facts: z
      .array(z.object({ id: key, text: text(2000) }).strict())
      .min(1)
      .max(100),
    sourceFiles: z.array(BrandContentFileRefSchema).max(24).default([]),
    strategies: z
      .array(z.object({ key, name: text(160), brief: text(4000) }).strict())
      .max(12)
      .default([]),
    campaign: z
      .object({
        key,
        name: text(160),
        brief: text(8000),
        startsAt: TimestampSchema.optional(),
        endsAt: TimestampSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.facts.map((f) => f.id)).size !== value.facts.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Fact identifiers must be unique.',
      });
    if (
      new Set(value.strategies.map((s) => s.key)).size !==
      value.strategies.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Strategy identifiers must be unique.',
      });
    if (
      value.campaign?.startsAt &&
      value.campaign.endsAt &&
      Date.parse(value.campaign.startsAt) > Date.parse(value.campaign.endsAt)
    )
      ctx.addIssue({ code: 'custom', message: 'Campaign end precedes start.' });
    if (
      new Set(value.sourceFiles.map((f) => f.objectId.toLowerCase())).size !==
      value.sourceFiles.length
    )
      ctx.addIssue({ code: 'custom', message: 'Source files must be unique.' });
  });

export const BrandContentCandidateSchema = z
  .object({
    title: text(240),
    angle: text(2000),
    outline: text(6000),
    audience: text(2000),
    rationale: text(4000),
    factIds: z.array(key).min(1).max(100),
    imageBrief: z.string().trim().max(4000).default(''),
    suggestedWindow: z.string().trim().max(500).default(''),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.factIds).size !== v.factIds.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Fact references must be unique.',
      });
  });
export const BrandContentImageSchema = z
  .object({
    slotKey: key,
    file: BrandContentFileRefSchema,
    sourceKind: z.enum(['uploaded', 'generated']),
    operationId: UuidSchema.optional(),
    caption: z.string().trim().max(1000).default(''),
  })
  .strict()
  .superRefine((image, ctx) => {
    if ((image.sourceKind === 'generated') !== Boolean(image.operationId))
      ctx.addIssue({
        code: 'custom',
        message: 'Only generated images require an image operation.',
      });
  });
const base = {
  ...BrandContentScopeSchema.shape,
  requestId: text(200),
  workflow: BrandContentWorkflowPinSchema.optional(),
};
const articleBase = {
  ...base,
  brandId: UuidSchema,
  articleId: UuidSchema,
  expectedRevision: revision,
};
const images = z
  .array(BrandContentImageSchema)
  .max(12)
  .superRefine((items, ctx) => {
    if (new Set(items.map((i) => i.slotKey)).size !== items.length)
      ctx.addIssue({ code: 'custom', message: 'Image slots must be unique.' });
  });
export const BrandContentOperationSchema = z.enum([
  'context.save',
  'topics.propose',
  'topics.decide',
  'article.submit',
  'article.images',
  'article.review',
  'plan.save',
  'plan.cancel',
  'plan.reminder',
  'receipt.record',
  'feedback.record',
  'retrospective.save',
  'experience.propose',
  'experience.review',
]);
export const BrandContentActionSchema = z.discriminatedUnion('operation', [
  z
    .object({
      ...base,
      operation: z.literal('experience.review'),
      brandId: UuidSchema,
      memoryId: UuidSchema,
      decision: z.enum(['approve', 'reject']),
      expectedRevision: revision,
      expectedDigest: ChecksumSchema,
      reason: text(500),
    })
    .strict(),
  BrandFeedbackInputSchema.safeExtend({
    ...base,
    operation: z.literal('feedback.record'),
    brandId: UuidSchema,
  }),
  z
    .object({
      ...base,
      operation: z.literal('retrospective.save'),
      brandId: UuidSchema,
      contextRevisionId: UuidSchema,
      platform: text(80),
      runId: UuidSchema,
      sessionId: UuidSchema,
      output: BrandRetrospectiveOutputSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('experience.propose'),
      brandId: UuidSchema,
      retrospectiveId: UuidSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('context.save'),
      brandId: UuidSchema.optional(),
      expectedRevision: revision,
      name: text(160),
      content: BrandContextContentSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('topics.propose'),
      brandId: UuidSchema,
      contextRevisionId: UuidSchema,
      platform: text(80),
      candidates: z.array(BrandContentCandidateSchema).min(1).max(40),
      experienceUses: BrandExperienceUsesSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('topics.decide'),
      brandId: UuidSchema,
      batchId: UuidSchema,
      expectedRevision: revision,
      choices: z
        .array(
          z
            .object({
              topicId: UuidSchema,
              decision: z.enum(['accepted', 'rejected']),
              reason: z.string().trim().max(2000).default(''),
            })
            .strict(),
        )
        .min(1)
        .max(40),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (
        new Set(v.choices.map((x) => x.topicId.toLowerCase())).size !==
        v.choices.length
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Topic choices must be unique.',
        });
    }),
  z
    .object({
      ...base,
      operation: z.literal('article.submit'),
      brandId: UuidSchema,
      articleId: UuidSchema.optional(),
      expectedRevision: revision,
      topicId: UuidSchema,
      sessionId: UuidSchema,
      content: BrandContentVersionRefSchema,
      parentVersionId: UuidSchema.optional(),
      reviewId: UuidSchema.optional(),
      changeSummary: text(2000),
      experienceUses: BrandExperienceUsesSchema.optional(),
      images: images.default([]),
    })
    .strict(),
  z
    .object({
      ...articleBase,
      operation: z.literal('article.images'),
      bundleDigest: ChecksumSchema,
      images,
      removeSlots: z.array(key).max(12).default([]),
      changeSummary: text(2000),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (
        new Set(v.removeSlots).size !== v.removeSlots.length ||
        v.images.some((i) => v.removeSlots.includes(i.slotKey)) ||
        (!v.images.length && !v.removeSlots.length)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Choose distinct image slots to update or remove.',
        });
    }),
  z
    .object({
      ...articleBase,
      operation: z.literal('article.review'),
      bundleDigest: ChecksumSchema,
      decision: z.enum(['approved', 'rejected']),
      reason: text(2000),
    })
    .strict(),
  z
    .object({
      ...articleBase,
      operation: z.literal('plan.save'),
      planId: UuidSchema.optional(),
      bundleDigest: ChecksumSchema,
      reviewId: UuidSchema,
      platform: text(80),
      plannedAt: TimestampSchema,
      timezone: text(64).refine((s) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: s });
          return true;
        } catch {
          return false;
        }
      }, 'Choose an IANA timezone'),
      publisher: text(160),
      notes: z.string().trim().max(2000).default(''),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('plan.cancel'),
      brandId: UuidSchema,
      planId: UuidSchema,
      expectedRevision: revision,
      reason: text(2000),
    })
    .strict(),
  z
    .object({
      ...base,
      operation: z.literal('plan.reminder'),
      brandId: UuidSchema,
      planId: UuidSchema,
      expectedRevision: revision,
      status: z.enum(['registered', 'reminded', 'failed', 'unknown']),
      automationId: UuidSchema,
      automationRunId: UuidSchema.optional(),
      runId: UuidSchema.optional(),
      deliveryMessageId: UuidSchema.optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (
        v.status !== 'registered' &&
        (!v.automationRunId || (!v.runId && !v.deliveryMessageId))
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Reminder outcomes require an actual occurrence and Run or delivered private message.',
        });
      if (
        v.status === 'registered' &&
        (v.automationRunId || v.runId || v.deliveryMessageId)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Registration does not claim a completed occurrence.',
        });
      if (v.deliveryMessageId && (v.runId || v.status !== 'reminded'))
        ctx.addIssue({
          code: 'custom',
          message:
            'A deterministic message receipt confirms only an actual completed reminder.',
        });
    }),
  z
    .object({
      ...base,
      operation: z.literal('receipt.record'),
      brandId: UuidSchema,
      planId: UuidSchema,
      expectedRevision: revision,
      bundleDigest: ChecksumSchema,
      platform: text(80),
      publisher: text(160),
      publishedUrl: z
        .url()
        .max(2000)
        .refine((s) => {
          const u = new URL(s);
          return (
            ['http:', 'https:'].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            ![
              'localhost',
              'example.com',
              'example.org',
              'example.net',
            ].includes(u.hostname) &&
            !u.hostname.endsWith('.example.com') &&
            !u.hostname.endsWith('.invalid') &&
            !/^(127\.|0\.|10\.|192\.168\.|\[)/.test(u.hostname)
          );
        }, 'Provide a real public publication URL'),
      actualPublishedAt: TimestampSchema,
      sourceType: z.enum(['manual_confirmation', 'imported_public_record']),
      evidence: text(4000),
      evidenceFiles: z.array(BrandContentFileRefSchema).max(12).default([]),
    })
    .strict(),
]);
export type BrandContentAction = z.infer<typeof BrandContentActionSchema>;
export type BrandContentScope = z.infer<typeof BrandContentScopeSchema>;
export type BrandContentFileRef = z.infer<typeof BrandContentFileRefSchema>;
export type BrandContentVersionRef = z.infer<
  typeof BrandContentVersionRefSchema
>;
export type BrandContentImage = z.infer<typeof BrandContentImageSchema>;
export type BrandContextContent = z.infer<typeof BrandContextContentSchema>;
export type BrandContentCandidate = z.infer<typeof BrandContentCandidateSchema>;
export type BrandContentWorkflowPin = z.infer<
  typeof BrandContentWorkflowPinSchema
>;

export const BrandContentMutationReceiptSchema = z
  .object({
    operation: BrandContentOperationSchema,
    requestId: text(200),
    replayed: z.boolean(),
    result: z
      .object({
        brandId: UuidSchema,
        entityId: UuidSchema,
        revision: z.number().int().positive(),
        state: text(80),
        contextRevisionId: UuidSchema.optional(),
        topicIds: z.array(UuidSchema).optional(),
        duplicateTopicIds: z.array(UuidSchema).optional(),
        bundleDigest: ChecksumSchema.optional(),
        reviewId: UuidSchema.optional(),
        reminderStatus: z
          .enum([
            'not_registered',
            'registered',
            'reminded',
            'failed',
            'unknown',
          ])
          .optional(),
      })
      .strict(),
  })
  .strict();
export type BrandContentMutationReceipt = z.infer<
  typeof BrandContentMutationReceiptSchema
>;

export const BrandContentReadSchema = BrandContentScopeSchema.extend({
  brandId: UuidSchema,
});
export const RegisterBrandContentReminderSchema =
  BrandContentScopeSchema.extend({
    brandId: UuidSchema,
    planId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    requestId: text(200),
  }).strict();
export const BrandContentBrandSchema = z
  .object({
    id: UuidSchema,
    name: text(160),
    revision: z.number().int().positive(),
    contextRevisionId: UuidSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export const BrandContentBoardSchema = z
  .object({
    brand: BrandContentBrandSchema,
    contexts: z.array(
      z
        .object({
          id: UuidSchema,
          brandName: text(160),
          number: z.number().int().positive(),
          digest: ChecksumSchema,
          content: BrandContextContentSchema,
          createdAt: TimestampSchema,
        })
        .strict(),
    ),
    batches: z.array(
      z
        .object({
          id: UuidSchema,
          contextRevisionId: UuidSchema,
          platform: text(80),
          revision: z.number().int().positive(),
          topicIds: z.array(UuidSchema),
          workflow: BrandContentWorkflowPinSchema.nullable(),
          createdAt: TimestampSchema,
        })
        .strict(),
    ),
    topics: z.array(
      z
        .object({
          id: UuidSchema,
          contextRevisionId: UuidSchema,
          platform: text(80),
          candidate: BrandContentCandidateSchema,
          state: z.enum(['candidate', 'accepted', 'rejected']),
          revision: z.number().int().positive(),
          decisionReason: z.string(),
          createdAt: TimestampSchema,
        })
        .strict(),
    ),
    articles: z.array(
      z
        .object({
          id: UuidSchema,
          topicId: UuidSchema,
          contextRevisionId: UuidSchema,
          topicRevision: z.number().int().positive(),
          platform: text(80),
          sessionId: UuidSchema,
          revision: z.number().int().positive(),
          state: z.enum(['awaiting_review', 'changes_requested', 'approved']),
          currentBundleId: UuidSchema,
          createdAt: TimestampSchema,
          updatedAt: TimestampSchema,
        })
        .strict(),
    ),
    bundles: z.array(
      z
        .object({
          id: UuidSchema,
          articleId: UuidSchema,
          number: z.number().int().positive(),
          content: BrandContentVersionRefSchema,
          images,
          digest: ChecksumSchema,
          parentBundleId: UuidSchema.nullable(),
          changeSummary: text(2000),
          sourceReviewId: UuidSchema.nullable(),
          workflow: BrandContentWorkflowPinSchema.nullable(),
          createdAt: TimestampSchema,
        })
        .strict(),
    ),
    reviews: z.array(
      z
        .object({
          id: UuidSchema,
          articleId: UuidSchema,
          bundleId: UuidSchema,
          bundleDigest: ChecksumSchema,
          decision: z.enum(['approved', 'rejected']),
          reason: text(2000),
          decidedBy: UuidSchema,
          createdAt: TimestampSchema,
        })
        .strict(),
    ),
    plans: z.array(
      z
        .object({
          id: UuidSchema,
          articleId: UuidSchema,
          bundleId: UuidSchema,
          bundleDigest: ChecksumSchema,
          reviewId: UuidSchema,
          revision: z.number().int().positive(),
          platform: text(80),
          plannedAt: TimestampSchema,
          timezone: text(64),
          publisher: text(160),
          notes: z.string(),
          state: z.enum(['planned', 'cancelled']),
          reminderStatus: z.enum([
            'not_registered',
            'registered',
            'reminded',
            'failed',
            'unknown',
          ]),
          automationId: UuidSchema.nullable(),
          automationRunId: UuidSchema.nullable(),
          runId: UuidSchema.nullable(),
          reminderMessageId: UuidSchema.nullable().default(null),
          createdAt: TimestampSchema,
          updatedAt: TimestampSchema,
        })
        .strict(),
    ),
    receipts: z.array(
      z
        .object({
          id: UuidSchema,
          planId: UuidSchema,
          bundleDigest: ChecksumSchema,
          platform: text(80),
          publisher: text(160),
          publishedUrl: z.string(),
          actualPublishedAt: TimestampSchema,
          sourceType: z.enum(['manual_confirmation', 'imported_public_record']),
          evidence: text(4000),
          evidenceFiles: z.array(BrandContentFileRefSchema),
          recordedBy: UuidSchema,
          verificationState: z.literal('provided'),
          createdAt: TimestampSchema,
        })
        .strict(),
    ),
    feedback: z.array(BrandFeedbackSchema).optional(),
    retrospectives: z.array(BrandRetrospectiveSchema).optional(),
    experiences: z.array(BrandExperienceSchema).optional(),
    unavailableFeedbackSources: z.boolean().optional(),
    experienceUses: z
      .array(
        z
          .object({
            entityId: UuidSchema,
            memoryId: UuidSchema,
            revision: z.number().int().positive(),
            digest: ChecksumSchema,
            reason: text(600),
            createdAt: TimestampSchema,
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean(),
  })
  .strict();
export type BrandContentBoard = z.infer<typeof BrandContentBoardSchema>;
