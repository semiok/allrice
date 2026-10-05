import { z } from 'zod';
import { UuidSchema, WorkerOperationsSchema } from '@allrice/contracts';

// Admin-only browser contracts stay outside the Bridge import graph.
const OperationsInventorySchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  workers: z
    .array(
      WorkerOperationsSchema.extend({
        observedAt: z.string().datetime({ offset: true }),
        online: z.boolean(),
      }),
    )
    .max(100),
});

export const TechnicalEnvironmentSchema = z.enum([
  'dev',
  'prod',
  'test',
  'unknown',
]);
export const TechnicalIssueStatusSchema = z.enum([
  'open',
  'investigating',
  'resolved',
  'ignored',
]);
export const TechnicalIssueCategorySchema = z.enum([
  'unknown',
  'configuration',
  'upstream',
  'capacity',
  'quality',
  'defect',
]);
export const TechnicalSeveritySchema = z.enum(['low', 'medium', 'high']);
const Code = z
  .string()
  .regex(/^[A-Za-z0-9_.:-]{1,100}$/)
  .nullable();
const Time = z.string().datetime({ offset: true });
const Evidence = z
  .object({
    source: z.enum([
      'web_health',
      'worker_health',
      'worker_samples',
      'execution_pressure',
      'runs',
      'operations',
      'feedback',
    ]),
    environment: TechnicalEnvironmentSchema,
    freshness: z.enum(['fresh', 'stale', 'unknown']),
    sampledAt: Time.nullable(),
    windowStart: Time.nullable(),
    windowEnd: Time.nullable(),
    unavailableReason: z
      .enum(['collection_failed', 'not_configured', 'no_sample'])
      .nullable(),
  })
  .strict();
export type TechnicalEvidence = z.infer<typeof Evidence>;

function sample<T extends z.ZodType>(value: T) {
  return z
    .object({ evidence: Evidence, value: value.nullable() })
    .strict()
    .superRefine((input, ctx) => {
      if (
        !('value' in input) ||
        (input.evidence.freshness === 'unknown') !== (input.value === null)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Unknown collections have no measured value',
        });
    });
}
const Health = z
  .object({
    status: z.enum(['ready', 'not_ready', 'unreachable']),
    releaseSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
  })
  .strict();
export const TechnicalRecordSchema = z
  .object({
    kind: z.enum(['run', 'operation', 'feedback']),
    id: UuidSchema,
    runId: UuidSchema,
    jobId: UuidSchema.nullable(),
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    status: z.string().regex(/^[a-z_]{1,40}$/),
    errorCode: Code,
    action: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,120}$/)
      .nullable(),
    category: Code,
    observedAt: Time,
  })
  .strict();
export type TechnicalRecord = z.infer<typeof TechnicalRecordSchema>;
const Pressure = z
  .object({
    jobs: z
      .object({
        queued: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        longestWaitMs: z.number().nonnegative(),
      })
      .strict(),
    resources: z
      .object({
        waiting: z.number().int().nonnegative(),
        executing: z.number().int().nonnegative(),
      })
      .strict(),
    locks: z
      .array(
        z
          .object({
            pid: z.number().int(),
            blockingPids: z.array(z.number().int()),
            waitMs: z.number().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
export const TechnicalDiagnosticsSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: TechnicalEnvironmentSchema,
    capturedAt: Time,
    web: sample(Health),
    worker: sample(Health),
    inventory: sample(OperationsInventorySchema),
    pressure: sample(Pressure),
    runs: sample(z.array(TechnicalRecordSchema).max(20)),
    operations: sample(z.array(TechnicalRecordSchema).max(20)),
    feedback: sample(z.array(TechnicalRecordSchema).max(20)),
  })
  .strict();
export type TechnicalDiagnostics = z.infer<typeof TechnicalDiagnosticsSchema>;

export const CaptureTechnicalIssueSchema = z
  .object({
    kind: z.enum(['run', 'operation', 'feedback']),
    id: UuidSchema,
    /** Explicit grouping of independently observed sources, never guessed by a model. */
    issueId: UuidSchema.optional(),
  })
  .strict();
export const UpdateTechnicalIssueSchema = z
  .object({
    ifVersion: z.number().int().positive(),
    status: TechnicalIssueStatusSchema,
    category: TechnicalIssueCategorySchema,
    severity: TechnicalSeveritySchema,
  })
  .strict();
export const TechnicalIssueSchema = z
  .object({
    id: UuidSchema,
    environment: TechnicalEnvironmentSchema,
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    title: z.string().min(1).max(160),
    category: TechnicalIssueCategorySchema,
    severity: TechnicalSeveritySchema,
    status: TechnicalIssueStatusSchema,
    occurrenceCount: z.number().int().positive(),
    version: z.number().int().positive(),
    firstSeenAt: Time,
    lastSeenAt: Time,
    updatedAt: Time,
    linkedPr: z.string().url().nullable(),
    releaseSha: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
  })
  .strict();
export type TechnicalIssue = z.infer<typeof TechnicalIssueSchema>;
export const TechnicalIssueDetailSchema = z
  .object({
    issue: TechnicalIssueSchema,
    records: z.array(TechnicalRecordSchema).max(100),
  })
  .strict();
export const TechnicalAssistantResponseSchema = z
  .object({
    diagnostics: TechnicalDiagnosticsSchema,
    issues: z.array(TechnicalIssueSchema).max(100),
  })
  .strict();
