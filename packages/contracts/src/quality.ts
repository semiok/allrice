import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const EmployeeEvalCaseSchema = z
  .object({
    key: z.string().trim().min(1).max(120),
    kind: z.enum([
      'typical',
      'boundary',
      'multi_turn',
      'tool',
      'knowledge',
      'workflow',
      'security',
    ]),
    description: z.string().trim().min(1).max(1_000),
    critical: z.boolean().default(false),
  })
  .strict();

export const EmployeeEvalThresholdsSchema = z
  .object({
    taskSuccessRate: z.number().min(0).max(1),
    toolSuccessRate: z.number().min(0).max(1),
    routingAccuracy: z.number().min(0).max(1),
    recoveryRate: z.number().min(0).max(1),
    p95CompletionMs: z.number().int().positive(),
    maxCostCents: z.number().nonnegative(),
  })
  .strict();

export const EmployeeEvalMetricsSchema = EmployeeEvalThresholdsSchema.extend({
  permissionDenialRate: z.number().min(0).max(1),
  firstTokenP95Ms: z.number().int().nonnegative(),
  retryRate: z.number().min(0).max(1),
  compactionRecoveryRate: z.number().min(0).max(1),
}).strict();

export const EmployeeEvalViolationSchema = z
  .object({
    code: z.string().trim().min(1).max(160),
    severity: z.enum(['warning', 'critical']),
    detail: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const CreateEmployeeEvalSuiteInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    name: z.string().trim().min(1).max(160),
    cases: z.array(EmployeeEvalCaseSchema).min(1).max(200),
    thresholds: EmployeeEvalThresholdsSchema,
  })
  .strict();

export const RecordEmployeeEvalRunInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    employeeVersionId: UuidSchema,
    evalSuiteId: UuidSchema,
    harness: z.enum(['codex', 'dsh']),
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(200),
    metrics: EmployeeEvalMetricsSchema,
    violations: z.array(EmployeeEvalViolationSchema).max(100),
  })
  .strict();

export const EmployeeReleaseStageSchema = z.enum([
  'draft',
  'internal_test',
  'canary',
  'production',
  'disabled',
]);

export const UpdateEmployeeReleaseInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeId: UuidSchema,
    action: z.enum([
      'begin_internal_test',
      'start_canary',
      'promote',
      'rollback',
      'disable',
    ]),
    candidateVersionId: UuidSchema.optional(),
    trafficPercentage: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const RunFeedbackInputSchema = z
  .object({
    workspaceId: UuidSchema,
    messageId: UuidSchema,
    helpful: z.boolean(),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

export const EmployeeQualityActionInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create_eval_suite'),
      payload: z.unknown(),
    })
    .strict(),
  z
    .object({
      action: z.literal('record_eval_run'),
      payload: z.unknown(),
    })
    .strict(),
  z
    .object({
      action: z.literal('update_release'),
      payload: z.unknown(),
    })
    .strict(),
]);

export const EmployeeReleaseSchema = z
  .object({
    employeeId: UuidSchema,
    stableVersionId: UuidSchema,
    candidateVersionId: UuidSchema.nullable(),
    stage: EmployeeReleaseStageSchema,
    trafficPercentage: z.number().int().min(0).max(100),
    gateStatus: z.enum(['pending', 'passed', 'blocked']),
    approvedBy: UuidSchema.nullable(),
    approvedAt: TimestampSchema.nullable(),
    updatedAt: TimestampSchema,
  })
  .strict();

export type EmployeeEvalThresholds = z.infer<
  typeof EmployeeEvalThresholdsSchema
>;
export type EmployeeEvalMetrics = z.infer<typeof EmployeeEvalMetricsSchema>;
export type EmployeeEvalViolation = z.infer<typeof EmployeeEvalViolationSchema>;
