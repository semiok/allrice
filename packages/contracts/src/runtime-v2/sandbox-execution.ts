import { z } from 'zod';
import { UuidSchema } from '../common.ts';

export const defaultSandboxExecutionMs = 600_000;
export const SandboxExecutionLimitMsSchema = z.union([
  z.literal(600_000),
  z.literal(1_800_000),
  z.literal(3_600_000),
]);
export const SandboxExecutionPolicySourceSchema = z
  .object({
    scope: z.enum(['tenant', 'user']),
    scopeId: UuidSchema,
    source: z.enum(['tenant_override', 'platform_override']),
    maxExecutionMs: SandboxExecutionLimitMsSchema,
  })
  .strict();
export const SandboxExecutionPolicySchema = z
  .object({
    version: z.literal(1),
    maxExecutionMs: SandboxExecutionLimitMsSchema,
    sources: z.array(SandboxExecutionPolicySourceSchema).max(2),
  })
  .strict()
  .refine(
    (policy) =>
      new Set(policy.sources.map((s) => s.scope)).size ===
        policy.sources.length &&
      policy.maxExecutionMs ===
        (policy.sources.length
          ? Math.min(...policy.sources.map((s) => s.maxExecutionMs))
          : defaultSandboxExecutionMs),
    'sandbox_execution_policy_inconsistent',
  );
export type SandboxExecutionPolicy = z.infer<
  typeof SandboxExecutionPolicySchema
>;

/** Defaults apply only if no explicit constraint exists. A missing user override
 * must not silently cap an explicitly configured 30/60-minute tenant policy. */
export function resolveSandboxExecutionPolicy(
  sources: SandboxExecutionPolicy['sources'],
): SandboxExecutionPolicy {
  return SandboxExecutionPolicySchema.parse({
    version: 1,
    maxExecutionMs: sources.length
      ? Math.min(...sources.map((source) => source.maxExecutionMs))
      : defaultSandboxExecutionMs,
    sources,
  });
}
