import { z } from 'zod';

/** Deployment defaults may vary; these durable bounds and historical defaults do not. */
export const cloudCommandRuntimeLimitDefinitions = {
  timeoutMs: {
    min: 500,
    max: 60_000,
    default: 30_000,
    env: 'ALLRICE_CLOUD_COMMAND_TIMEOUT_MS',
    unit: 'ms',
  },
  outputBytes: {
    min: 1024,
    max: 65_536,
    default: 32_768,
    env: 'ALLRICE_CLOUD_COMMAND_OUTPUT_BYTES',
    unit: 'bytes',
  },
} as const;
const { timeoutMs, outputBytes } = cloudCommandRuntimeLimitDefinitions;
export const CloudCommandRuntimeLimitsSchema = z.object({
  timeoutMs: z.number().int().min(timeoutMs.min).max(timeoutMs.max),
  outputBytes: z.number().int().min(outputBytes.min).max(outputBytes.max),
});
export type CloudCommandRuntimeLimits = z.infer<
  typeof CloudCommandRuntimeLimitsSchema
>;
export const cloudCommandRuntimeDefaults: CloudCommandRuntimeLimits = {
  timeoutMs: timeoutMs.default,
  outputBytes: outputBytes.default,
};

/** Called at server startup and for new operations, never to decode frozen data. */
export function configuredCloudCommandRuntimeLimits(
  env: Record<string, string | undefined> = globalThis.process?.env ?? {},
): CloudCommandRuntimeLimits {
  const value = (definition: typeof timeoutMs | typeof outputBytes) => {
    const raw = env[definition.env];
    const parsed = raw === undefined ? definition.default : Number(raw);
    if (
      !Number.isInteger(parsed) ||
      parsed < definition.min ||
      parsed > definition.max
    )
      throw new Error(
        `${definition.env} must be an integer between ${definition.min} and ${definition.max}`,
      );
    return parsed;
  };
  return { timeoutMs: value(timeoutMs), outputBytes: value(outputBytes) };
}

/** Only the two omitted fields take defaults; explicit call values stay exact. */
export function resolveCloudCommandRuntimeLimits(
  limits: unknown,
  defaults: CloudCommandRuntimeLimits,
): CloudCommandRuntimeLimits {
  const supplied = CloudCommandRuntimeLimitsSchema.partial().parse(
    limits ?? {},
  );
  return {
    timeoutMs: supplied.timeoutMs ?? defaults.timeoutMs,
    outputBytes: supplied.outputBytes ?? defaults.outputBytes,
  };
}
