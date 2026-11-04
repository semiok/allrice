import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { RunStatusSchema } from './runs.ts';
import { EmployeeSceneReadSchema } from './employee-content.ts';
import {
  PersonalSceneContentRefSchema,
  PersonalSceneUseSchema,
} from './employee-scene-skills.ts';

const cursor = z
  .object({ createdAt: TimestampSchema, runId: UuidSchema })
  .strict();
export const PersonalSceneReadQuerySchema = z
  .object({
    workspaceId: UuidSchema.optional(),
    runId: UuidSchema.optional(),
    beforeCreatedAt: TimestampSchema.optional(),
    beforeRunId: UuidSchema.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (
      Boolean(query.beforeCreatedAt) !== Boolean(query.beforeRunId) ||
      (query.runId && query.beforeRunId)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Select a Run or a complete cursor.',
      });
  });
export const PersonalSceneContentQuerySchema = z
  .object({
    workspaceId: UuidSchema.optional(),
    contentRef: PersonalSceneContentRefSchema,
  })
  .strict();

/** Committed reads and separately attested native uses. Neither proves that
 * the model followed the content; missing use evidence is not a negative fact.
 * No body, resource bytes, private server context or legacy adopted receipt. */
export const PersonalSceneReadHistorySchema = z
  .object({
    instanceId: UuidSchema,
    runs: z.array(
      z
        .object({
          runId: UuidSchema,
          sessionId: UuidSchema,
          messageId: UuidSchema,
          createdAt: TimestampSchema,
          status: RunStatusSchema,
          error: z
            .object({
              code: z.literal('EMPLOYEE_CONTENT_UNAVAILABLE').nullable(),
              message: z.string(),
            })
            .strict()
            .nullable(),
          reads: z.array(
            z
              .object({
                receiptId: UuidSchema,
                sceneId: UuidSchema,
                contentRef: PersonalSceneContentRefSchema,
                contentChecksum:
                  EmployeeSceneReadSchema.shape.personal.unwrap().shape
                    .contentChecksum,
                bundleChecksum:
                  EmployeeSceneReadSchema.shape.personal.unwrap().shape
                    .bundleChecksum,
                contentRead: z.boolean(),
                resources:
                  EmployeeSceneReadSchema.shape.personal.unwrap().shape
                    .resources,
                generationId: UuidSchema,
                readAt: TimestampSchema,
                uses: z
                  .array(
                    PersonalSceneUseSchema.extend({
                      eventId: UuidSchema,
                      eventSequence: z.number().int().nonnegative(),
                      recordedAt: TimestampSchema,
                    }).strict(),
                  )
                  .default([]),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    nextCursor: cursor.nullable(),
  })
  .strict();
export type PersonalSceneReadHistory = z.infer<
  typeof PersonalSceneReadHistorySchema
>;
