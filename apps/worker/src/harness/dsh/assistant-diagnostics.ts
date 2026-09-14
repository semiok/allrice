import { types } from 'node:util';
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

/** JSON-RPC delivers plain JSON. Reject accessors/proxies/cycles even for direct
 * callers, before a schema parser can accidentally execute their properties. */
function plainData(value: unknown, depth = 0): boolean {
  if (typeof value !== 'object' || value === null) return true;
  if (depth > 4 || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    prototype !== Array.prototype
  )
    return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 65) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === 'string' &&
      !!descriptor &&
      'value' in descriptor &&
      plainData(descriptor.value, depth + 1)
    );
  });
}

export function parseAssistantFailureDiagnostics(
  value: unknown,
): AssistantFailureDiagnostics | undefined {
  try {
    if (!plainData(value)) return undefined;
    const result = AssistantFailureDiagnosticsSchema.safeParse(value);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

// Do not inspect, traverse or mutate an arbitrary original error/cause/result.
// This sidecar also works with frozen objects and never alters serialization or
// retry policy. Partial result objects pass it to their later completion error.
const errorDiagnostics = new WeakMap<object, AssistantFailureDiagnostics>();
export function attachAssistantFailureDiagnostics(
  error: unknown,
  diagnostics: unknown,
) {
  if (typeof error !== 'object' || error === null || types.isProxy(error))
    return;
  const safe = parseAssistantFailureDiagnostics(diagnostics);
  if (safe) errorDiagnostics.set(error, safe);
}
export function getAssistantFailureDiagnostics(
  error: unknown,
): AssistantFailureDiagnostics | undefined {
  if (typeof error !== 'object' || error === null || types.isProxy(error))
    return undefined;
  return parseAssistantFailureDiagnostics(errorDiagnostics.get(error));
}
