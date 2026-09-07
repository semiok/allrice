import { z } from 'zod';
import { UuidSchema, TimestampSchema } from '../common.ts';
export const InteractionStatusSchema = z
  .object({
    pendingActions: z
      .array(
        z
          .object({
            approvalId: UuidSchema,
            operationId: UuidSchema,
            artifactId: UuidSchema.nullable().optional(),
            runId: UuidSchema,
            expiresAt: TimestampSchema,
          })
          .strict(),
      )
      .max(30)
      .default([]),
    runtime: z
      .object({
        state: z.enum(['running', 'idle', 'interrupted', 'error']),
        runId: UuidSchema.nullable(),
        turnId: z.string().max(255).nullable(),
        generation: z.number().int().nonnegative(),
        configChecksum: z.string(),
        currentVersionId: UuidSchema.nullable(),
        nextVersionId: UuidSchema.nullable(),
      })
      .strict()
      .nullable(),
    inputs: z
      .array(
        z
          .object({
            inputId: UuidSchema,
            kind: z.enum([
              'message',
              'steer_current',
              'queue_next',
              'ask_user',
              'plan_review',
              'version_feedback',
              'changeset_request',
            ]),
            status: z.enum([
              'adopted',
              'unknown',
              'rejected',
              'pending',
              'received',
              'queued',
              'running',
              'completed',
              'canceled',
              'failed',
            ]),
            runId: UuidSchema.nullable(),
            messageId: UuidSchema,
            artifactId: UuidSchema.nullable(),
            createdAt: TimestampSchema,
            turnId: z.string().max(255).nullable(),
            generation: z.number().int().nonnegative().nullable(),
            evidence: z
              .object({
                sequence: z.number().int().nonnegative(),
                checkpoint: z.enum(['question_resolved', 'step_user_message']),
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
export type InteractionStatus = z.infer<typeof InteractionStatusSchema>;
