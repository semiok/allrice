import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  BrandContextContentSchema,
  BrandContentCandidateSchema,
  BrandContentImageSchema,
  BrandContentVersionRefSchema,
} from './brand-content.ts';

export const BrandContentToolReadSchema = z
  .object({ brandId: UuidSchema.optional() })
  .strict();

export const BrandContentWorkflowStageSchema = z.enum([
  'topics',
  'article',
  'revision',
  'handoff',
]);
export type BrandContentWorkflowStage = z.infer<
  typeof BrandContentWorkflowStageSchema
>;

export const brandContentTemplateKeys = {
  topics: 'brand-content-operations.topics',
  article: 'brand-content-operations.article',
  revision: 'brand-content-operations.revision',
  handoff: 'brand-content-operations.handoff',
} as const;

/** A human starts a bounded business stage. The server resolves the executable
 * and copies the exact business versions; the client cannot supply code or pins. */
export const StartBrandContentWorkflowSchema = z
  .object({
    workspaceId: UuidSchema,
    brandId: UuidSchema,
    requestId: UuidSchema,
    stage: BrandContentWorkflowStageSchema,
    sessionId: UuidSchema.optional(),
    topicId: UuidSchema.optional(),
    articleId: UuidSchema.optional(),
    platform: z.string().trim().min(1).max(80).optional(),
    count: z.number().int().positive().max(40).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.stage === 'topics' && !value.platform)
      ctx.addIssue({ code: 'custom', message: '请选择本次选题的平台。' });
    if (value.stage === 'article' && !value.topicId)
      ctx.addIssue({ code: 'custom', message: '请先选择已采纳的选题。' });
    if (
      (value.stage === 'revision' || value.stage === 'handoff') &&
      !value.articleId
    )
      ctx.addIssue({ code: 'custom', message: '请指定需要继续处理的稿件。' });
  });
export type StartBrandContentWorkflow = z.infer<
  typeof StartBrandContentWorkflowSchema
>;

export const BrandContentStageInputSchema = z
  .object({
    stage: BrandContentWorkflowStageSchema,
    brandId: UuidSchema,
    brandName: z.string().trim().min(1).max(160),
    contextRevisionId: UuidSchema,
    contextDigest: ChecksumSchema,
    context: BrandContextContentSchema,
    platform: z.string().trim().min(1).max(80),
    count: z.number().int().positive().max(40).optional(),
    topic: z
      .object({
        id: UuidSchema,
        candidate: BrandContentCandidateSchema,
      })
      .strict()
      .optional(),
    article: z
      .object({
        id: UuidSchema,
        expectedRevision: z.number().int().positive(),
        content: BrandContentVersionRefSchema,
        bundleDigest: ChecksumSchema,
        images: z.array(BrandContentImageSchema),
        feedback: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrandContentStageInput = z.infer<
  typeof BrandContentStageInputSchema
>;

/** Optional on new V2 snapshots only. Never inferred from a prompt, tool output,
 * previous message, or the currently published package during recovery. */
export const BrandContentWorkflowInvocationSchema = z
  .object({
    schemaVersion: z.literal(1),
    startId: UuidSchema,
    instanceId: UuidSchema,
    sceneId: UuidSchema.nullable(),
    workflowRevisionId: UuidSchema,
    packageDigest: ChecksumSchema,
    templateKey: z.enum(Object.values(brandContentTemplateKeys)),
    input: BrandContentStageInputSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (brandContentTemplateKeys[value.input.stage] !== value.templateKey)
      ctx.addIssue({ code: 'custom', message: '业务阶段与流程包不一致。' });
  });
export type BrandContentWorkflowInvocation = z.infer<
  typeof BrandContentWorkflowInvocationSchema
>;

export const BrandContentTopicsOutputSchema = z
  .object({ candidates: z.array(BrandContentCandidateSchema).min(1).max(40) })
  .strict();

export const BrandContentDraftOutputSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    markdown: z.string().trim().min(1).max(180_000),
    factIds: z.array(z.string().min(1)),
    verificationNotes: z.array(z.string().trim().min(1).max(2000)),
  })
  .strict();
