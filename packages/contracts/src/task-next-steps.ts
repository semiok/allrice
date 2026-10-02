import { z } from 'zod';
import { UuidSchema, VisibilitySchema } from './common.ts';
import { TaskSuggestionDisplaySchema } from './task-suggestions.ts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const TaskNextStepsInputSchema = z
  .object({
    workspaceId: UuidSchema,
    sessionId: UuidSchema,
    employeeAssignmentId: UuidSchema,
    employeeVersionId: UuidSchema,
  })
  .strict();
export type TaskNextStepsInput = z.infer<typeof TaskNextStepsInputSchema>;
export const TaskNextStepReferenceSchema = z
  .object({
    objectId: UuidSchema,
    versionId: UuidSchema,
    checksum: digest,
    fileName: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(255),
    sizeBytes: z.number().int().nonnegative().safe(),
    visibility: VisibilitySchema,
  })
  .strict();
export type TaskNextStepReference = z.infer<typeof TaskNextStepReferenceSchema>;
export const TaskNextStepSchema = z
  .object({
    source: z.literal('context-rule'),
    task: TaskSuggestionDisplaySchema,
    references: z.array(TaskNextStepReferenceSchema).max(1),
  })
  .strict();
export type TaskNextStep = z.infer<typeof TaskNextStepSchema>;
export const TaskNextStepsSchema = z
  .object({
    contractVersion: z.literal(1),
    scope: TaskNextStepsInputSchema.extend({
      organizationId: UuidSchema,
      viewerId: UuidSchema,
      sourceRunId: UuidSchema.nullable(),
      contextRevision: digest,
    }).strict(),
    state: z.enum([
      'idle',
      'running',
      'succeeded',
      'failed',
      'canceled',
      'unknown',
    ]),
    readableArtifactCount: z.number().int().min(0).max(50),
    notice: z.string().max(600),
    suggestions: z.array(TaskNextStepSchema).max(3),
  })
  .strict()
  .superRefine((response, ctx) => {
    const ids = response.suggestions.map((s) => s.task.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['suggestions'],
        message: 'duplicate next steps',
      });
    if (response.scope.sourceRunId === null && response.suggestions.length)
      ctx.addIssue({
        code: 'custom',
        path: ['suggestions'],
        message: 'next steps require a source Run',
      });
  });
export type TaskNextSteps = z.infer<typeof TaskNextStepsSchema>;
