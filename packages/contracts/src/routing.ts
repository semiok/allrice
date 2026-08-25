import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';
import { HarnessKindSchema } from './harness.ts';
import { ChecksumSchema } from './runs.ts';
import { SkillCapabilitySchema } from './skills.ts';

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
  'primary_harness_selected',
  'fallback_harness_selected',
  'provider_unavailable',
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
    costCents: z.number().nonnegative(),
    errorCode: z.string().trim().min(1).max(160).nullable(),
    completedAt: TimestampSchema,
  })
  .strict();
export type RouteOutcome = z.infer<typeof RouteOutcomeSchema>;
