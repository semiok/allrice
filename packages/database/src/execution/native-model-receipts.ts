import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import { getDatabase } from '../core/client.ts';

const token = z.number().int().nonnegative().safe().optional();
const usage = z.strictObject({
  inputTokens: token,
  cacheReadTokens: token,
  cacheWriteTokens: token,
  outputTokens: token,
});
const identity = {
  callId: UuidSchema,
  nativeSessionId: z.string().min(1).max(255),
  provider: z.string().min(1).max(160),
  model: z.string().min(1).max(160),
  purpose: z.string().min(1).max(160).optional(),
};
// DSH's four disjoint buckets, never inherited Session totals. Missing is unknown.
export const NativeModelFactSchema = z.discriminatedUnion('phase', [
  z.strictObject({ ...identity, phase: z.literal('start') }),
  z
    .strictObject({
      ...identity,
      phase: z.literal('finish'),
      outcome: z.enum(['succeeded', 'failed', 'canceled', 'incomplete']),
      usage: usage.optional(),
      usageComplete: z.boolean(),
    })
    .refine(
      (v) =>
        !v.usageComplete ||
        (v.usage?.inputTokens !== undefined &&
          v.usage.cacheReadTokens !== undefined &&
          v.usage.cacheWriteTokens !== undefined &&
          v.usage.outputTokens !== undefined),
      'Complete usage requires all four buckets',
    ),
]);
export const nativeModelReceiptSource = 'native_model_receipt_v1';
export function isNativeModelReceipt(value: unknown) {
  return (
    value !== null &&
    typeof value === 'object' &&
    'source' in value &&
    value.source === nativeModelReceiptSource
  );
}
export const NativeModelReceiptSchema = z.strictObject({
  source: z.literal(nativeModelReceiptSource),
  sourceKey: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  rootSessionId: z.string().min(1).max(255),
  runId: UuidSchema,
  jobId: UuidSchema,
  jobAttempt: z.number().int().positive(),
  routeDecisionId: UuidSchema,
  routeAttempt: z.number().int().positive(),
  fact: NativeModelFactSchema,
});
export type NativeModelFact = z.infer<typeof NativeModelFactSchema>;

/** Worker-only aggregation input. Starts without finishes remain visible and
 * unknown; no inferred finish, inherited history, zero-fill or cash arithmetic. */
export async function readNativeModelReceipts(input: {
  organizationId: string;
  workspaceId: string;
  runId: string;
  routeDecisionId: string;
}) {
  const sql = getDatabase();
  const rows = await sql`select payload from allrice_run_events
    where organization_id=${UuidSchema.parse(input.organizationId)}
      and workspace_id=${UuidSchema.parse(input.workspaceId)}
      and run_id=${UuidSchema.parse(input.runId)} and event_type='harness.native'
      and payload->>'source'=${nativeModelReceiptSource}
      and payload->>'routeDecisionId'=${UuidSchema.parse(input.routeDecisionId)}
    order by sequence`;
  return rows.map((row) => NativeModelReceiptSchema.parse(row.payload));
}
