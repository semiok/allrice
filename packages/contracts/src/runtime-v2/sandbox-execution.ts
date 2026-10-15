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

/** Opt-in only. The request selects the work type, never its authorized cap. */
export const SandboxExecutionRequestSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['compute', 'install', 'build']),
  })
  .strict();
export const SandboxExecutionBudgetSpecSchema = z
  .object({
    version: z.literal(1),
    kind: SandboxExecutionRequestSchema.shape.kind,
    policy: SandboxExecutionPolicySchema,
    initialBudgetMs: z.union([z.literal(60000), z.literal(120000)]),
  })
  .strict()
  .refine(
    (v) => v.initialBudgetMs === (v.kind === 'compute' ? 60000 : 120000),
    'sandbox_initial_budget_invalid',
  );
export type SandboxExecutionBudgetSpec = z.infer<
  typeof SandboxExecutionBudgetSpecSchema
>;

export function sandboxExecutionBudgetSpec(
  request: z.infer<typeof SandboxExecutionRequestSchema>,
  policy: SandboxExecutionPolicy,
): SandboxExecutionBudgetSpec {
  return SandboxExecutionBudgetSpecSchema.parse({
    ...SandboxExecutionRequestSchema.parse(request),
    policy,
    initialBudgetMs: request.kind === 'compute' ? 60000 : 120000,
  });
}

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const SandboxExecutionObservationSchema = z
  .object({
    startedAt: counter,
    hardDeadlineAt: counter,
    deadlineAt: counter,
    initialBudgetMs: z.union([z.literal(60000), z.literal(120000)]),
    maxExecutionMs: SandboxExecutionLimitMsSchema,
    renewalCount: z.number().int().min(0).max(60),
  })
  .strict()
  .refine(
    (v) =>
      v.startedAt < v.deadlineAt &&
      v.deadlineAt <= v.hardDeadlineAt &&
      v.hardDeadlineAt <= v.startedAt + v.maxExecutionMs,
    'sandbox_execution_observation_invalid',
  );
export type SandboxExecutionObservation = z.infer<
  typeof SandboxExecutionObservationSchema
>;
/** Trusted executor measurements, never stdout, model JSON or a heartbeat. */
export const SandboxExecutionProgressSchema = z
  .object({
    cpuNanos: counter,
    readBytes: counter,
    writtenBytes: counter,
  })
  .strict();
export type SandboxExecutionProgress = z.infer<
  typeof SandboxExecutionProgressSchema
>;
export const SandboxExecutionRenewalSchema = z
  .object({
    requestId: UuidSchema,
    sequence: z.number().int().min(1).max(60),
    progress: SandboxExecutionProgressSchema,
  })
  .strict();
export type SandboxExecutionRenewal = z.infer<
  typeof SandboxExecutionRenewalSchema
>;
export const SandboxExecutionBudgetStateSchema = z
  .object({
    version: z.literal(1),
    spec: SandboxExecutionBudgetSpecSchema,
    startedAt: counter,
    hardDeadlineAt: counter,
    deadlineAt: counter,
    lastProgressAt: counter,
    progress: SandboxExecutionProgressSchema,
    sequence: z.number().int().min(0).max(60),
    renewals: z
      .array(
        SandboxExecutionRenewalSchema.extend({
          grantedAt: counter,
          deadlineAt: counter,
        }),
      )
      .max(60),
  })
  .strict()
  .refine(
    (v) =>
      v.startedAt < v.deadlineAt &&
      v.deadlineAt <= v.hardDeadlineAt &&
      v.hardDeadlineAt <= v.startedAt + v.spec.policy.maxExecutionMs &&
      v.startedAt <= v.lastProgressAt &&
      v.lastProgressAt < v.hardDeadlineAt &&
      v.renewals.length === v.sequence &&
      v.renewals.every(
        (r, i) =>
          r.sequence === i + 1 &&
          r.grantedAt >= v.startedAt &&
          r.grantedAt < r.deadlineAt &&
          r.deadlineAt <= v.hardDeadlineAt,
      ) &&
      new Set(v.renewals.map((r) => r.requestId)).size === v.renewals.length,
    'sandbox_execution_clock_invalid',
  );
export type SandboxExecutionBudgetState = z.infer<
  typeof SandboxExecutionBudgetStateSchema
>;

export function startSandboxExecutionBudget(
  input: SandboxExecutionBudgetSpec,
  now: number,
  rootDeadlineAt: number,
): SandboxExecutionBudgetState {
  const spec = SandboxExecutionBudgetSpecSchema.parse(input);
  counter.parse(now);
  counter.parse(rootDeadlineAt);
  if (rootDeadlineAt <= now) throw Error('SANDBOX_EXECUTION_DEADLINE');
  const hardDeadlineAt = Math.min(
    rootDeadlineAt,
    now + spec.policy.maxExecutionMs,
  );
  return SandboxExecutionBudgetStateSchema.parse({
    version: 1,
    spec,
    startedAt: now,
    hardDeadlineAt,
    deadlineAt: Math.min(hardDeadlineAt, now + spec.initialBudgetMs),
    lastProgressAt: now,
    progress: { cpuNanos: 0, readBytes: 0, writtenBytes: 0 },
    sequence: 0,
    renewals: [],
  });
}

/** Finite, persisted extensions; retries cannot reset the clock or revive an
 * expired process. A separate five-second physical lease handles host loss. */
export function renewSandboxExecutionBudget(
  stateInput: SandboxExecutionBudgetState,
  requestInput: SandboxExecutionRenewal,
  now: number,
  rootDeadlineAt: number,
): SandboxExecutionBudgetState {
  const state = SandboxExecutionBudgetStateSchema.parse(stateInput);
  const request = SandboxExecutionRenewalSchema.parse(requestInput);
  counter.parse(now);
  counter.parse(rootDeadlineAt);
  if (
    now < state.startedAt ||
    now >= Math.min(state.deadlineAt, rootDeadlineAt)
  )
    throw Error('SANDBOX_EXECUTION_DEADLINE');
  const prior = state.renewals.find((r) => r.requestId === request.requestId);
  if (prior) {
    if (
      prior.sequence !== request.sequence ||
      JSON.stringify(prior.progress) !== JSON.stringify(request.progress)
    )
      throw Error('SANDBOX_EXECUTION_RENEWAL_CONFLICT');
    return state;
  }
  if (request.sequence !== state.sequence + 1)
    throw Error('SANDBOX_EXECUTION_RENEWAL_CONFLICT');
  if (state.deadlineAt - now > 15000)
    throw Error('SANDBOX_EXECUTION_RENEWAL_EARLY');
  const fields = ['cpuNanos', 'readBytes', 'writtenBytes'] as const;
  if (fields.some((k) => request.progress[k] < state.progress[k]))
    throw Error('SANDBOX_EXECUTION_PROGRESS_CHANGED');
  const advanced =
    request.progress.cpuNanos - state.progress.cpuNanos >= 1_000_000 ||
    request.progress.readBytes > state.progress.readBytes ||
    request.progress.writtenBytes > state.progress.writtenBytes;
  const lastProgressAt = advanced ? now : state.lastProgressAt;
  if (now - lastProgressAt >= 120000)
    throw Error('SANDBOX_EXECUTION_NO_PROGRESS');
  const deadlineAt = Math.min(
    state.hardDeadlineAt,
    rootDeadlineAt,
    state.deadlineAt + 60000,
  );
  if (deadlineAt <= state.deadlineAt) throw Error('SANDBOX_EXECUTION_LIMIT');
  return SandboxExecutionBudgetStateSchema.parse({
    ...state,
    deadlineAt,
    lastProgressAt,
    progress: request.progress,
    sequence: request.sequence,
    renewals: [...state.renewals, { ...request, grantedAt: now, deadlineAt }],
  });
}
