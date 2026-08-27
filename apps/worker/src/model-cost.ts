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
  const price = (input.pricing ?? readModelPricing())[
    `${input.provider}:${input.model}`
  ];
  if (!price) return 0;
  const billableInput = Math.max(
    0,
    input.inputTokens - input.cachedInputTokens,
  );
  return (
    (billableInput * price.inputCentsPerMillion +
      input.outputTokens * price.outputCentsPerMillion) /
    1_000_000
  );
}
