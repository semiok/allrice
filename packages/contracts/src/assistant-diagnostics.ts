import { z } from 'zod';

/** Observe-only data from the owned native host. Never an authorization signal,
 * provider error message, model answer, or instruction to retry a request. */
export const AssistantDiagnosticCodeSchema = z.enum([
  'AUTH',
  'QUOTA_EXCEEDED',
  'RATE_LIMIT',
  'INVALID_REQUEST',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'PI_AI_ERROR',
  'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE',
  'ABORTED',
  'STREAM_CLOSED',
  'UNKNOWN',
  'MAX_TOKENS',
  'USAGE_INCOMPLETE',
  'SETTLEMENT_REJECTED',
  'SETTLEMENT_FAILED',
]);
const FailureSchema = z
  .object({
    nativeSessionId: z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/),
    callId: z.uuid(),
    phase: z.enum(['finish', 'stream', 'usage', 'settlement']),
    code: AssistantDiagnosticCodeSchema,
    stopKind: z.enum([
      'error',
      'aborted',
      'max-tokens',
      'stop',
      'tool-calls',
      'unknown',
    ]),
    inputUsageKnown: z.boolean(),
    outputUsageKnown: z.boolean(),
    settlementConfirmed: z.boolean(),
    settlementFailureCode: AssistantDiagnosticCodeSchema.optional(),
  })
  .strict();
export const AssistantFailureDiagnosticsSchema = z
  .object({
    version: z.literal(1),
    failures: z.array(FailureSchema).max(64),
    truncated: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.failures.map((failure) => failure.callId)).size ===
      value.failures.length,
    { message: 'duplicate_diagnostic_call' },
  );
export type AssistantFailureDiagnostics = z.infer<
  typeof AssistantFailureDiagnosticsSchema
>;
