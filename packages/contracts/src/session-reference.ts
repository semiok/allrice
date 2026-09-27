import { z } from 'zod';
import { TimestampSchema, UuidSchema, VisibilitySchema } from './common.ts';

export const SessionReferenceSchema = z
  .object({
    sessionId: UuidSchema,
    label: z.string().min(1).max(240),
  })
  .strict();
export type SessionReference = z.infer<typeof SessionReferenceSchema>;

/** Server-captured text only. Never accepted from a browser or a model. */
export const SessionReferenceSnapshotSchema = SessionReferenceSchema.extend({
  visibility: VisibilitySchema,
  capturedAt: TimestampSchema,
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  originalMessages: z.number().int().nonnegative(),
  truncated: z.boolean(),
  messages: z
    .array(
      z
        .object({
          id: UuidSchema,
          role: z.enum(['user', 'assistant']),
          text: z.string().max(100_000),
          createdAt: TimestampSchema,
        })
        .strict(),
    )
    .max(200),
}).strict();
export const SessionReferenceSnapshotsSchema = z
  .array(SessionReferenceSnapshotSchema)
  .max(3);
export type SessionReferenceSnapshot = z.infer<
  typeof SessionReferenceSnapshotSchema
>;
