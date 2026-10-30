import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import type postgres from 'postgres';

const token = z.number().int().nonnegative().safe().optional();
const usage = z.strictObject({
  inputTokens: token,
  cacheReadTokens: token,
  cacheWriteTokens: token,
  outputTokens: token,
  totalTokens: token,
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
        (v.outcome !== 'incomplete' &&
          v.usage?.inputTokens !== undefined &&
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

export const NativeModelDeliverySchema = z.strictObject({
  calls: z.number().int().nonnegative().safe(),
  complete: z.boolean(),
});
export interface NativeModelSettlement {
  rootSessionId: string;
  jobId: string;
  jobAttempt: number;
  delivery: z.infer<typeof NativeModelDeliverySchema>;
  price?: { inputCentsPerMillion: number; outputCentsPerMillion: number };
}

/** Only the route's locked settlement transaction reads these immutable facts. */
export async function aggregateNativeModelReceipts(
  tx: postgres.TransactionSql,
  scope: { organizationId: string; workspaceId: string },
  route: {
    id: string;
    run_id: string;
    attempt: number;
    provider: string;
    model: string;
  },
  native: NativeModelSettlement,
) {
  const rows = await tx<{ payload: unknown }[]>`
    select payload from allrice_run_events
    where organization_id=${scope.organizationId} and workspace_id=${scope.workspaceId}
      and run_id=${route.run_id} and payload->>'source'=${nativeModelReceiptSource}
      and payload->>'routeDecisionId'=${route.id}`;
  const calls = new Map<string, Map<string, NativeModelFact>>();
  for (const row of rows) {
    const receipt = NativeModelReceiptSchema.parse(row.payload);
    if (
      receipt.rootSessionId !== native.rootSessionId ||
      receipt.jobId !== native.jobId ||
      receipt.jobAttempt !== native.jobAttempt ||
      receipt.routeAttempt !== route.attempt ||
      receipt.runId !== route.run_id ||
      receipt.fact.provider !== route.provider ||
      receipt.fact.model !== route.model
    )
      throw Error('NATIVE_RECEIPT_SCOPE_CONFLICT');
    const pair =
      calls.get(receipt.sourceKey) ?? new Map<string, NativeModelFact>();
    pair.set(receipt.fact.phase, receipt.fact);
    calls.set(receipt.sourceKey, pair);
  }
  let usageComplete =
    native.delivery.complete &&
    native.delivery.calls > 0 &&
    native.delivery.calls === calls.size;
  let inputTokens = 0,
    cachedInputTokens = 0,
    outputTokens = 0;
  for (const pair of calls.values()) {
    const start = pair.get('start'),
      finish = pair.get('finish');
    if (!start || finish?.phase !== 'finish') {
      usageComplete = false;
      continue;
    }
    if (
      start.callId !== finish.callId ||
      start.nativeSessionId !== finish.nativeSessionId ||
      start.provider !== finish.provider ||
      start.model !== finish.model ||
      start.purpose !== finish.purpose
    )
      throw Error('NATIVE_RECEIPT_PAIR_CONFLICT');
    usageComplete &&= finish.usageComplete;
    const u = finish.usage;
    const input =
      (u?.inputTokens ?? 0) +
      (u?.cacheReadTokens ?? 0) +
      (u?.cacheWriteTokens ?? 0);
    inputTokens += input;
    cachedInputTokens += u?.cacheReadTokens ?? 0;
    outputTokens += u?.outputTokens ?? 0;
    usageComplete &&=
      input > 0 &&
      (u?.totalTokens === undefined ||
        u.totalTokens === input + (u.outputTokens ?? 0));
  }
  if (
    ![
      inputTokens,
      cachedInputTokens,
      outputTokens,
      inputTokens + outputTokens,
    ].every(Number.isSafeInteger)
  )
    throw Error('NATIVE_RECEIPT_USAGE_OVERFLOW');
  const price = native.price;
  const cost =
    price && usageComplete
      ? ((inputTokens - cachedInputTokens) * price.inputCentsPerMillion +
          outputTokens * price.outputCentsPerMillion) /
        1_000_000
      : null;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    usageComplete,
    cacheUsageKnown: usageComplete,
    costCents:
      cost !== null && Number.isFinite(cost) && cost >= 0 ? cost : null,
  };
}
