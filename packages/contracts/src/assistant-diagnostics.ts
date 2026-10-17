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
export const ModelTransportFailureCodeSchema = z.enum([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const ModelTimingMsSchema = z.number().int().nonnegative().safe();
/** Operator logs only. Missing/pooled/WS/credential internals stay unknown.
 * Offsets use the same monotonic call origin; no prompt, URL or secret fields. */
export const ModelCallTimingSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum([
      'prepared',
      'waiting',
      'first_content',
      'completed',
      'failed',
    ]),
    startedAt: z.iso.datetime(),
    elapsedMs: ModelTimingMsSchema,
    preparationMs: ModelTimingMsSchema,
    ledgerPreparationMs: ModelTimingMsSchema,
    authorizationReadMs: z.null(),
    firstChunkMs: ModelTimingMsSchema.nullable(),
    firstContentMs: ModelTimingMsSchema.nullable(),
    firstTextMs: ModelTimingMsSchema.nullable(),
    firstReasoningMs: ModelTimingMsSchema.nullable(),
    firstToolCallMs: ModelTimingMsSchema.nullable(),
    serializationMs: ModelTimingMsSchema.optional(),
    admissionMs: ModelTimingMsSchema.optional(),
    inputBytes: z.number().int().nonnegative().safe().optional(),
    toolCount: z.number().int().nonnegative().safe().optional(),
    stopKind: z
      .enum(['error', 'aborted', 'max-tokens', 'stop', 'tool-calls', 'unknown'])
      .optional(),
    settlementMs: ModelTimingMsSchema.optional(),
    settlementConfirmed: z.boolean().optional(),
    transport: z.enum(['sse', 'websocket', 'unobserved']),
    requestCount: z.number().int().nonnegative().safe(),
    websocketRequests: z.number().int().nonnegative().safe(),
    requestsTruncated: z.boolean(),
    httpRequests: z
      .array(
        z
          .object({
            startedMs: ModelTimingMsSchema.nullable(),
            connectionStartedMs: ModelTimingMsSchema.nullable(),
            connectionReadyMs: ModelTimingMsSchema.nullable(),
            bodySentMs: ModelTimingMsSchema.nullable(),
            headersMs: ModelTimingMsSchema.nullable(),
            firstByteMs: ModelTimingMsSchema.nullable(),
            firstEventMs: ModelTimingMsSchema.nullable(),
            closedMs: ModelTimingMsSchema.nullable(),
            status: z.number().int().min(100).max(599).optional(),
            errorCode: ModelTransportFailureCodeSchema.optional(),
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export const ModelCallTimingNotificationSchema = z
  .object({
    sessionId: z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/),
    callId: z.uuid(),
    timing: ModelCallTimingSchema,
  })
  .strict();
export type ModelCallTimingNotification = z.infer<
  typeof ModelCallTimingNotificationSchema
>;
export const ModelStreamDiagnosticSchema = z
  .object({
    transport: z.enum(['sse', 'websocket', 'unobserved']),
    state: z.enum([
      'transport_closed',
      'heartbeat_only',
      'missing_terminal',
      'transport_active',
      'transport_silent',
      'unobserved',
    ]),
    bytes: z.number().int().nonnegative().safe(),
    heartbeats: z.number().int().nonnegative().safe(),
    events: z.number().int().nonnegative().safe(),
    terminalEvent: z.boolean(),
    outputItemEnded: z.boolean(),
    readFailed: z.boolean(),
    lastByteAgeMs: z.number().int().nonnegative().safe().optional(),
    localCloseConfirmed: z.boolean(),
    finishSeen: z.boolean(),
    recoveryEligible: z.boolean(),
    // Last scoped HTTP attempt only; never a URL, header, body or error text.
    request: z
      .object({
        phase: z.enum([
          'awaiting_headers',
          'headers_received',
          'request_failed',
          'body_failed',
        ]),
        elapsedMs: z.number().int().nonnegative().safe(),
        aborted: z.boolean(),
        status: z.number().int().min(100).max(599).optional(),
        errorCode: ModelTransportFailureCodeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
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
    stream: ModelStreamDiagnosticSchema.optional(),
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
