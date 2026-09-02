import { z } from 'zod';

export const UserQuestionOptionSchema = z
  .object({
    label: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();

export const UserQuestionItemSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    question: z.string().trim().min(1).max(4_000),
    detail: z.string().trim().min(1).max(20_000).optional(),
    header: z.string().trim().min(1).max(160).optional(),
    options: z.array(UserQuestionOptionSchema).max(20).optional(),
    multiSelect: z.boolean().default(false),
    intent: z
      .object({
        kind: z.literal('plan-review'),
        approve: z.string().trim().min(1).max(240),
      })
      .strict()
      .optional(),
  })
  .strict();

export const UserQuestionAnswerItemSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    selected: z.array(z.string().trim().min(1).max(240)).max(20),
    custom: z.string().trim().min(1).max(20_000).optional(),
  })
  .strict();

export const UserQuestionRequestSchema = z
  .object({
    questionId: z.string().trim().min(1).max(240),
    questions: z.array(UserQuestionItemSchema).min(1).max(10),
  })
  .strict();

export const UserQuestionAnswerSubmissionSchema = z
  .object({
    questionId: z.string().trim().min(1).max(240),
    answers: z.array(UserQuestionAnswerItemSchema).min(1).max(10),
  })
  .strict();

export type UserQuestionItem = z.infer<typeof UserQuestionItemSchema>;
export type UserQuestionRequest = z.infer<typeof UserQuestionRequestSchema>;
export type UserQuestionAnswerSubmission = z.infer<
  typeof UserQuestionAnswerSubmissionSchema
>;
