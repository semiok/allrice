import { z } from 'zod';
import { UuidSchema } from './common.ts';

export const FeedbackCategorySchema = z.enum([
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
]);
export type FeedbackCategory = z.infer<typeof FeedbackCategorySchema>;
export const MessageFeedbackItemSchema = z
  .object({
    messageId: UuidSchema,
    rating: z.enum(['positive', 'negative']),
    note: z.string().optional(),
    category: FeedbackCategorySchema.optional(),
    version: UuidSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();
export type MessageFeedbackItem = z.infer<typeof MessageFeedbackItemSchema>;
export const MessageFeedbackPutSchema = z
  .object({
    messageId: UuidSchema,
    rating: z.enum(['positive', 'negative']),
    note: z.string().trim().min(1).max(4000).optional(),
    category: FeedbackCategorySchema.optional(),
    ifVersion: UuidSchema.nullable(),
  })
  .strict();
export const MessageFeedbackDeleteSchema = z
  .object({
    messageId: UuidSchema,
    ifVersion: UuidSchema,
  })
  .strict();
export const FeedbackReviewStatusSchema = z.enum([
  'new',
  'reviewing',
  'resolved',
]);
export const FeedbackReviewInputSchema = z
  .object({
    ifVersion: UuidSchema,
    status: FeedbackReviewStatusSchema,
    note: z.string().trim().max(4000).default(''),
  })
  .strict();
export const FeedbackInboxQuerySchema = z
  .object({
    organizationId: UuidSchema.optional(),
    employeeId: UuidSchema.optional(),
    category: FeedbackCategorySchema.optional(),
    rating: z.enum(['positive', 'negative']).optional(),
    status: FeedbackReviewStatusSchema.optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
  })
  .strict();
export type MessageFeedbackResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; current: MessageFeedbackItem | null } };
