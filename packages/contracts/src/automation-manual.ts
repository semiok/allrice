/** AllRice browser presentation only. Not exported by native-runtime.ts. */
import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { RunSnapshotSchema } from './queue.ts';

export const ManualAutomationRunInputSchema = z
  .object({
    requestId: UuidSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type ManualAutomationRunInput = z.infer<
  typeof ManualAutomationRunInputSchema
>;
export const ManualAutomationRunReceiptSchema = z
  .object({
    source: z.literal('manual'),
    taskId: UuidSchema,
    request: ManualAutomationRunInputSchema,
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    automationRunId: UuidSchema,
    requestedAt: TimestampSchema,
    sessionId: UuidSchema,
    run: RunSnapshotSchema,
  })
  .strict();
export const AutomationOccurrenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native_occurrence') }).strict(),
  z.object({ kind: z.literal('legacy_run') }).strict(),
  z
    .object({
      kind: z.literal('manual'),
      requestId: UuidSchema,
      requestedAt: TimestampSchema,
    })
    .strict(),
]);
