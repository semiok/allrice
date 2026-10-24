import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
export const BrandPublicationUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      host.includes('.') &&
      !/^(?:\d+\.){3}\d+$|^\[/.test(host) &&
      !['localhost', 'example.com', 'example.org', 'example.net'].includes(
        host,
      ) &&
      !/\.(localhost|local|test|invalid|example|example\.(com|org|net))$/.test(
        host,
      )
    );
  }, '请填写真实公开来源的 HTTPS 链接');
export const BrandContentMetricsSchema = z
  .object({
    views: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    likes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    comments: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    shares: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    saves: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict();
export const BrandFeedbackInputSchema = z
  .object({
    contextRevisionId: UuidSchema,
    receiptId: UuidSchema.optional(),
    publicationKind: z.enum(['receipt', 'imported_publication']),
    title: text(240),
    platform: text(80),
    publishedUrl: BrandPublicationUrlSchema,
    publishedAt: TimestampSchema,
    sampledAt: TimestampSchema,
    sourceType: z.enum(['public_page', 'platform_export', 'manual_report']),
    sourceUrl: BrandPublicationUrlSchema,
    evidence: text(4000),
    limitations: text(2000),
    metrics: BrandContentMetricsSchema,
    evidenceFiles: z
      .array(
        z
          .object({
            objectId: UuidSchema,
            checksum: ChecksumSchema,
            versionId: UuidSchema.optional(),
          })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.publicationKind === 'receipt') !== Boolean(v.receiptId))
      ctx.addIssue({
        code: 'custom',
        message: '系统稿件需关联发布回执；外部样本不关联本系统稿件。',
      });
    if (Date.parse(v.sampledAt) < Date.parse(v.publishedAt))
      ctx.addIssue({ code: 'custom', message: '采样时间不能早于发布时间。' });
  });
export const BrandFeedbackSchema = BrandFeedbackInputSchema.safeExtend({
  id: UuidSchema,
  digest: ChecksumSchema,
  createdAt: TimestampSchema,
});
export type BrandFeedback = z.infer<typeof BrandFeedbackSchema>;
export const BrandRetrospectiveOutputSchema = z
  .object({
    summary: text(1000),
    rule: text(1000),
    applicability: text(600),
    limitations: text(800),
    feedbackIds: z.array(UuidSchema).min(1).max(20),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.feedbackIds).size !== v.feedbackIds.length)
      ctx.addIssue({ code: 'custom', message: '复盘来源不可重复。' });
  });
export const BrandRetrospectiveSchema = z
  .object({
    id: UuidSchema,
    contextRevisionId: UuidSchema,
    platform: text(80),
    campaignKey: z.string().nullable(),
    feedbackIds: z.array(UuidSchema),
    output: BrandRetrospectiveOutputSchema,
    sourceText: text(4000),
    runId: UuidSchema,
    sessionId: UuidSchema,
    createdAt: TimestampSchema,
  })
  .strict();
export const BrandExperiencePinSchema = z
  .object({
    id: UuidSchema,
    revision: z.number().int().positive(),
    digest: ChecksumSchema,
    content: text(4000),
    retrospectiveId: UuidSchema,
    platform: text(80),
    campaignKey: z.string().nullable(),
  })
  .strict();
export type BrandExperiencePin = z.infer<typeof BrandExperiencePinSchema>;
export const BrandExperienceSchema = BrandExperiencePinSchema.extend({
  status: z.enum(['pending', 'approved', 'rejected']),
  archived: z.boolean(),
}).strict();
export const BrandExperienceUseSchema = z
  .object({
    id: UuidSchema,
    reason: text(600),
  })
  .strict();
export const BrandExperienceUsesSchema = z
  .array(BrandExperienceUseSchema)
  .max(20)
  .superRefine((v, ctx) => {
    if (new Set(v.map((x) => x.id)).size !== v.length)
      ctx.addIssue({ code: 'custom', message: '经验引用不可重复。' });
  });

/** Unknown metrics remain null; no summed "engagement" or causal uplift. */
export function summarizeBrandFeedback(samples: BrandFeedback[]) {
  return samples.map((sample) => ({
    feedbackId: sample.id,
    knownMetrics: Object.entries(sample.metrics)
      .filter(([, n]) => n !== null)
      .map(([key]) => key),
    unknownMetrics: Object.entries(sample.metrics)
      .filter(([, n]) => n === null)
      .map(([key]) => key),
    likesPerView:
      sample.metrics.views && sample.metrics.likes !== null
        ? sample.metrics.likes / sample.metrics.views
        : null,
  }));
}

export function brandRetrospectiveSource(
  output: z.infer<typeof BrandRetrospectiveOutputSchema>,
  id: string,
) {
  return `复盘 ${id}\n建议：${output.rule}\n适用范围：${output.applicability}\n局限：${output.limitations}\n来源：${output.feedbackIds.join('、')}`;
}
