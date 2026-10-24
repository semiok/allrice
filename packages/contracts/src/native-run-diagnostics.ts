import { z } from 'zod';
import { UuidSchema } from './common.ts';

const count = z.number().int().nonnegative().nullable();
const time = z.number().finite().nonnegative().nullable();
const identity = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,255}$/)
  .nullable();
export const NativeDiagnosticEventTypeSchema = z.enum([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'llm/retry',
  'llm/retry-started',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
]);
export const NativeDiagnosticReasonSchema = z.enum([
  'run_in_progress',
  'source_receipts_missing',
  'source_receipts_truncated',
  'source_ambiguous',
  'binding_unavailable',
  'reader_unavailable',
  'journal_unavailable',
  'journal_requires_migration',
  'journal_too_large',
  'source_event_missing',
  'source_event_mismatch',
  'events_truncated',
  'stream_unavailable',
  'stream_truncated',
  'turn_end_unobserved',
]);
export type NativeDiagnosticReason = z.infer<
  typeof NativeDiagnosticReasonSchema
>;
const usage = z
  .object({
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
    cacheReadTokens: count,
    cacheWriteTokens: count,
    reasoningTokens: count,
  })
  .strict();
const stream = z
  .object({
    chunkCount: count,
    firstChunkAt: time,
    firstReasoningAt: time,
    firstTextAt: time,
    finishAt: time,
    groups: z
      .array(
        z
          .object({
            type: z.enum([
              'block-start',
              'block-end',
              'text-delta',
              'reasoning-delta',
              'tool-call-delta',
              'usage',
              'finish',
              'error',
              'other',
            ]),
            index: count,
            count: z.number().int().positive(),
            firstAt: time,
            lastAt: time,
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export const NativeDiagnosticEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    type: NativeDiagnosticEventTypeSchema,
    time,
    turn: count,
    step: count,
    source: z.enum(['run_receipt', 'verified_run_turn']),
    tool: z
      .object({ name: identity, callId: identity, errorCode: identity })
      .strict()
      .optional(),
    retry: z
      .object({ retryId: identity, retry: count, delayMs: count })
      .strict()
      .optional(),
    compactionId: identity.optional(),
    usage: usage.optional(),
    stream: stream.optional(),
  })
  .strict();
export type NativeDiagnosticEvent = z.infer<typeof NativeDiagnosticEventSchema>;
export const NativeRunDiagnosticsSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: UuidSchema,
    observedAt: z.string().datetime(),
    source: z.literal('native_persisted_journal'),
    clock: z.literal('native_wall_clock_epoch_ms'),
    providerWire: z.null(),
    status: z.enum(['available', 'partial', 'unavailable']),
    reasons: z.array(NativeDiagnosticReasonSchema).max(32),
    slices: z
      .array(
        z
          .object({
            attempt: z.number().int().positive(),
            generation: z.number().int().nonnegative(),
            nativeSessionId: z
              .string()
              .regex(/^dsh-[A-Za-z0-9._:-]+$/)
              .max(255),
            artifactId: z
              .string()
              .regex(/^sha256:[a-f0-9]{64}$/)
              .nullable(),
            distributionGeneration: z.string().max(240).nullable(),
            lastPersistedSeq: count,
            status: z.enum(['available', 'partial', 'unavailable']),
            reasons: z.array(NativeDiagnosticReasonSchema).max(32),
            events: z.array(NativeDiagnosticEventSchema).max(512),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type NativeRunDiagnostics = z.infer<typeof NativeRunDiagnosticsSchema>;

/** Internal HTTP input has identities only. Paths, artifacts and native cuts
 * are resolved independently from the authenticated Run in the Worker. */
export const NativeRunDiagnosticsRequestSchema = z
  .object({
    runId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
  })
  .strict();
