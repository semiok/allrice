import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { HarnessKindSchema } from './harness.ts';
import { ChecksumSchema } from './runs.ts';
import { SkillCapabilitySchema } from './skills.ts';
import { ProviderFailureCategorySchema } from './governance.ts';

export const RouteKindSchema = z.enum([
  'direct',
  'knowledge',
  'agent_skill',
  'workflow',
  'tool',
]);
export type RouteKind = z.infer<typeof RouteKindSchema>;

export const RouteReasonCodeSchema = z.enum([
  'direct_no_capability_match',
  'matched_explicit_intent',
  'matched_name_or_scenario',
  'minimum_necessary_capability',
  'ambiguous_deterministic_tiebreak',
  'excluded_not_effective',
  'excluded_acl_denied',
  'excluded_capability_denied',
  'excluded_approval_required',
  'excluded_connector_identity',
  'fallback_no_authorized_candidate',
  'primary_provider_selected',
  'fallback_provider_selected',
  // Historical values retained so durable decisions written before the
  // single-DSH migration remain readable. New executions must use the
  // provider-scoped reason codes above.
  'primary_harness_selected',
  'fallback_harness_selected',
  'provider_unavailable',
  'fallback_condition_provider_unavailable',
  'fallback_condition_rate_limited',
  'fallback_condition_timeout',
  'fallback_condition_transient_error',
]);
export type RouteReasonCode = z.infer<typeof RouteReasonCodeSchema>;

export const RouteCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(240),
    kind: RouteKindSchema,
    name: z.string().trim().min(1).max(200),
    bindingId: UuidSchema.nullable(),
    requiredCapabilities: z.array(SkillCapabilitySchema).max(16),
    risk: z.enum(['low', 'medium', 'high', 'critical']),
    requiresApproval: z.boolean(),
    authorized: z.boolean(),
    exclusionReason: RouteReasonCodeSchema.nullable(),
    score: z.number().int().min(0).max(10_000),
  })
  .strict();
export type RouteCandidate = z.infer<typeof RouteCandidateSchema>;

export const RouteRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    actorId: UuidSchema,
    employeeId: UuidSchema,
    generation: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    prompt: z.string().min(1).max(100_000),
  })
  .strict();
export type RouteRequest = z.infer<typeof RouteRequestSchema>;

export const RouteDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: UuidSchema,
    runId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    actorId: UuidSchema,
    employeeId: UuidSchema,
    inputChecksum: ChecksumSchema,
    candidates: z.array(RouteCandidateSchema).max(256),
    selectedKind: RouteKindSchema,
    selectedCandidateId: z.string().trim().min(1).max(240),
    harness: HarnessKindSchema,
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    modelConnectionId: UuidSchema.nullable().default(null),
    modelCatalogEntryId: UuidSchema.nullable().default(null),
    modelPolicyRevision: z.number().int().positive().nullable().default(null),
    fallbackFromDecisionId: UuidSchema.nullable().default(null),
    fallbackCondition: z
      .enum([
        'provider_unavailable',
        'rate_limited',
        'timeout',
        'transient_error',
      ])
      .nullable()
      .default(null),
    generation: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    reasonCodes: z.array(RouteReasonCodeSchema).min(1).max(32),
    createdAt: TimestampSchema,
  })
  .strict();
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export const RouteOutcomeSchema = z
  .object({
    decisionId: UuidSchema,
    status: z.enum(['succeeded', 'failed', 'canceled']),
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    // NULL is not zero/free: only a separately persisted, server-verified route
    // subscription proof makes it monetary N/A. Without that proof it is unknown.
    costCents: z.number().nonnegative().nullable(),
    cacheUsageKnown: z.boolean().default(true),
    usageComplete: z.boolean().default(true),
    errorCode: z.string().trim().min(1).max(160).nullable(),
    failureCategory: ProviderFailureCategorySchema.nullable().default(null),
    completedAt: TimestampSchema,
  })
  .strict();
export type RouteOutcome = z.input<typeof RouteOutcomeSchema>;
