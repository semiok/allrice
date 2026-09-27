import { z } from 'zod';

const PricingSchema = z.record(
  z.string(),
  z
    .object({
      inputCentsPerMillion: z.number().nonnegative(),
      outputCentsPerMillion: z.number().nonnegative(),
    })
    .strict(),
);

export function readModelPricing(
  encoded = process.env.ALLRICE_MODEL_PRICING_JSON,
) {
  if (!encoded) return {};
  return PricingSchema.parse(JSON.parse(encoded));
}

export function estimateModelCostCents(input: {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  pricing?: ReturnType<typeof readModelPricing>;
}) {
  // Pricing is optional telemetry. A missing/invalid tariff must neither stop
  // useful work nor turn an unknown cost into a reported zero.
  let pricing: ReturnType<typeof readModelPricing>;
  try {
    pricing = input.pricing ?? readModelPricing();
  } catch {
    return null;
  }
  const price = pricing[`${input.provider}:${input.model}`];
  if (!price) return null;
  const billableInput = Math.max(
    0,
    input.inputTokens - input.cachedInputTokens,
  );
  const cost =
    (billableInput * price.inputCentsPerMillion +
      input.outputTokens * price.outputCentsPerMillion) /
    1_000_000;
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}
