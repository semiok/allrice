import { z } from 'zod';
import { ModelProviderAuthModeSchema } from './models.ts';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rate = z.string().regex(/^(0|[1-9][0-9]{0,15})$/);
const endpoint = z
  .string()
  .url()
  .max(500)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });

/** Resolved SERVER routing identity, never a model/tool supplied price selector.
 * Endpoint includes the API base path: compatible proxies are not OpenAI tariffs.
 */
export const AssistantPricingTargetSchema = z
  .object({
    connectionId: z.uuid(),
    catalogId: z.uuid(),
    harness: z.literal('dsh'),
    provider: token,
    authMode: ModelProviderAuthModeSchema,
    model: token,
    baseUrl: endpoint,
    serviceTier: token,
    modality: z.literal('text'),
  })
  .strict();
export type AssistantPricingTarget = z.infer<
  typeof AssistantPricingTargetSchema
>;

export const AssistantPriceEntrySchema = z
  .object({
    id: token,
    target: AssistantPricingTargetSchema,
    billingMode: z.literal('token_metered'),
    currency: z.string().regex(/^[A-Z]{3}$/),
    effectiveAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    // One fixed tariff band. No unproved long-context, modality or tier fallback.
    maxInputTokens: integer.positive(),
    maxOutputTokens: integer.positive(),
    rates: z
      .object({
        uncachedInputMicrounitsPerMillion: rate,
        cacheReadMicrounitsPerMillion: rate,
        cacheWriteMicrounitsPerMillion: rate,
        outputMicrounitsPerMillion: rate,
      })
      .strict(),
    // An auditable config source/version, not a URL fetched during settlement.
    source: z.object({ reference: token, digest }).strict(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (Date.parse(entry.effectiveAt) >= Date.parse(entry.expiresAt))
      ctx.addIssue({ code: 'custom', message: 'invalid price interval' });
    if (
      entry.target.authMode !== 'api_key' ||
      !['gemini', 'openai-compatible'].includes(entry.target.provider)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'unsupported token billing route',
      });
    if (
      entry.rates.uncachedInputMicrounitsPerMillion === '0' ||
      entry.rates.outputMicrounitsPerMillion === '0'
    )
      ctx.addIssue({
        code: 'custom',
        message: 'free or subscription billing is outside this contract',
      });
  });
export const AssistantPriceCatalogSchema = z
  .object({
    version: z.literal(1),
    catalogVersion: token,
    entries: z.array(AssistantPriceEntrySchema).min(1).max(128),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    if (
      new Set(catalog.entries.map((entry) => entry.id)).size !==
      catalog.entries.length
    )
      ctx.addIssue({ code: 'custom', message: 'duplicate price identity' });
  });
export type AssistantPriceCatalog = z.infer<typeof AssistantPriceCatalogSchema>;
export const AssistantPriceSnapshotSchema = z
  .object({
    version: z.literal(1),
    catalogVersion: token,
    selectedAt: z.iso.datetime(),
    price: AssistantPriceEntrySchema,
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const at = Date.parse(snapshot.selectedAt);
    if (
      at < Date.parse(snapshot.price.effectiveAt) ||
      at >= Date.parse(snapshot.price.expiresAt)
    )
      ctx.addIssue({ code: 'custom', message: 'price not valid at selection' });
  });
export type AssistantPriceSnapshot = z.infer<
  typeof AssistantPriceSnapshotSchema
>;

export class AssistantPricingError extends Error {
  constructor(
    readonly code:
      | 'ASSISTANT_PRICE_UNAVAILABLE'
      | 'ASSISTANT_PRICE_UNSUPPORTED_BILLING'
      | 'ASSISTANT_PRICE_AMBIGUOUS'
      | 'ASSISTANT_PRICE_USAGE_OUT_OF_BAND',
  ) {
    super(code);
  }
}

/** Call BEFORE resolver/native dispatch. No env lookup, network, default prices,
 * currency conversion or mapping subscription tokens to API cash charges.
 * The caller must supply its explicitly configured quota currency as well.
 */
export function selectAssistantPriceSnapshot(input: {
  catalog: unknown;
  target: AssistantPricingTarget;
  currency: string;
  at: string;
}): AssistantPriceSnapshot {
  const target = AssistantPricingTargetSchema.parse(input.target);
  if (
    target.authMode !== 'api_key' ||
    !['gemini', 'openai-compatible'].includes(target.provider)
  )
    throw new AssistantPricingError('ASSISTANT_PRICE_UNSUPPORTED_BILLING');
  const parsed = AssistantPriceCatalogSchema.safeParse(input.catalog);
  if (!parsed.success)
    throw new AssistantPricingError('ASSISTANT_PRICE_UNAVAILABLE');
  const at = Date.parse(z.iso.datetime().parse(input.at));
  const matches = parsed.data.entries.filter(
    (entry) =>
      entry.currency === input.currency &&
      Object.entries(target).every(
        ([key, value]) =>
          entry.target[key as keyof AssistantPricingTarget] === value,
      ) &&
      Date.parse(entry.effectiveAt) <= at &&
      at < Date.parse(entry.expiresAt),
  );
  if (matches.length !== 1)
    throw new AssistantPricingError(
      matches.length
        ? 'ASSISTANT_PRICE_AMBIGUOUS'
        : 'ASSISTANT_PRICE_UNAVAILABLE',
    );
  return AssistantPriceSnapshotSchema.parse({
    version: 1,
    catalogVersion: parsed.data.catalogVersion,
    selectedAt: input.at,
    price: matches[0],
  });
}

/** Canonical total input INCLUDES cache read/write. Output INCLUDES thinking.
 * Null is unknown; the native SDK's absent optional field is NOT a proven zero.
 * Provider adapters must establish this normalization before using the helper.
 */
export const AssistantPricedUsageSchema = z
  .object({
    inputTokens: integer.nullable(),
    cacheReadTokens: integer.nullable(),
    cacheWriteTokens: integer.nullable(),
    outputTokens: integer.nullable(),
    usageComplete: z.boolean(),
  })
  .strict()
  .superRefine((usage, ctx) => {
    if (
      usage.usageComplete &&
      (usage.inputTokens === null || usage.outputTokens === null)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'complete token usage requires totals',
      });
    if (
      usage.inputTokens !== null &&
      BigInt(usage.cacheReadTokens ?? 0) + BigInt(usage.cacheWriteTokens ?? 0) >
        BigInt(usage.inputTokens)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'cache tokens exceed total input',
      });
  });
export type AssistantPricedUsage = z.infer<typeof AssistantPricedUsageSchema>;

/** Exact fixed-point tariff arithmetic, not an invoice or a cash charge claim.
 * 1 picounit = 10^-12 currency units. Keep these exact numerators across calls,
 * then round ONCE when projecting to the older decimal-cents ledger/budget.
 */
export function assistantCostProjection(picounits: string) {
  if (!/^(0|[1-9][0-9]{0,39})$/.test(picounits))
    throw new Error('ASSISTANT_COST_RANGE');
  const amount = BigInt(picounits);
  const centsMillionths = (amount + 9_999n) / 10_000n;
  return {
    costPicounits: picounits,
    costMicrounitsCeiling: ((amount + 999_999n) / 1_000_000n).toString(),
    costCentsDecimal: `${centsMillionths / 1_000_000n}.${(centsMillionths % 1_000_000n).toString().padStart(6, '0')}`,
  };
}
export function estimateAssistantUsageCost(
  snapshotInput: AssistantPriceSnapshot,
  usageInput: AssistantPricedUsage,
) {
  const snapshot = AssistantPriceSnapshotSchema.parse(snapshotInput);
  const usage = AssistantPricedUsageSchema.parse(usageInput);
  const cacheUsageKnown =
    usage.cacheReadTokens !== null && usage.cacheWriteTokens !== null;
  if (
    (usage.inputTokens !== null &&
      usage.inputTokens > snapshot.price.maxInputTokens) ||
    (usage.outputTokens !== null &&
      usage.outputTokens > snapshot.price.maxOutputTokens)
  )
    throw new AssistantPricingError('ASSISTANT_PRICE_USAGE_OUT_OF_BAND');
  if (!usage.usageComplete)
    return {
      currency: snapshot.price.currency,
      quality: 'unknown' as const,
      costBasis: 'unknown' as const,
      actualCostKnown: false as const,
      cacheUsageKnown,
      costPicounits: null,
      costMicrounitsCeiling: null,
      costCentsDecimal: null,
    };
  const rates = snapshot.price.rates;
  if (!cacheUsageKnown) {
    // Each total-input token belongs to exactly one disjoint tariff bucket.
    // Charging ALL input at the highest rate cannot make caching look free.
    const maximumInputRate = [
      rates.uncachedInputMicrounitsPerMillion,
      rates.cacheReadMicrounitsPerMillion,
      rates.cacheWriteMicrounitsPerMillion,
    ]
      .map(BigInt)
      .reduce((maximum, value) => (value > maximum ? value : maximum));
    const amount =
      BigInt(usage.inputTokens!) * maximumInputRate +
      BigInt(usage.outputTokens!) * BigInt(rates.outputMicrounitsPerMillion);
    return {
      currency: snapshot.price.currency,
      quality: 'tariff_estimate' as const,
      costBasis: 'conservative_upper_bound' as const,
      actualCostKnown: false as const,
      cacheUsageKnown,
      ...assistantCostProjection(amount.toString()),
    };
  }
  const read = BigInt(usage.cacheReadTokens!),
    write = BigInt(usage.cacheWriteTokens!);
  const amount =
    (BigInt(usage.inputTokens!) - read - write) *
      BigInt(rates.uncachedInputMicrounitsPerMillion) +
    read * BigInt(rates.cacheReadMicrounitsPerMillion) +
    write * BigInt(rates.cacheWriteMicrounitsPerMillion) +
    BigInt(usage.outputTokens!) * BigInt(rates.outputMicrounitsPerMillion);
  return {
    currency: snapshot.price.currency,
    quality: 'tariff_estimate' as const,
    costBasis: 'observed_token_tariff' as const,
    actualCostKnown: false as const,
    cacheUsageKnown,
    ...assistantCostProjection(amount.toString()),
  };
}
