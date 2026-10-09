import { z } from 'zod';
import { ChecksumSchema, UuidSchema } from '@allrice/contracts';
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const time = z.string().datetime({ offset: true });
const finding = z
  .object({
    id: z.enum([
      'service_unavailable',
      'resource_wait',
      'quality_failure',
      'secret_output',
    ]),
    occurrences: z.number().int().min(1).max(1000000),
    errorCode: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,120}$/)
      .nullable(),
  })
  .strict();
export const MaintenanceReportPayloadSchema = z
  .object({
    version: z.literal(1),
    sourceReportId: UuidSchema,
    sourceKind: z.enum(['deployment_health', 'quality_check']),
    sampledAt: time,
    observedReleaseSha: sha,
    producerVersion: z.literal('allrice-maintenance.v1'),
    facts: z
      .object({
        findings: z.array(finding).max(12),
        quality: z
          .object({
            caseId: z.enum(['project.static.v1', 'project.live.v1']),
            variant: z.enum(['correct', 'defect']),
            verdict: z.enum([
              'passed',
              'assertion_failed',
              'blocked',
              'execution_failed',
              'canceled',
              'unknown',
            ]),
            reportDigest: ChecksumSchema,
            cleanup: z.enum(['confirmed', 'pending', 'unknown']),
          })
          .strict()
          .nullable(),
        probe: z
          .object({
            specId: z.literal('command-output.credentials.v2'),
            fixtureDigest: ChecksumSchema,
            failedAssertions: z
              .array(
                z.enum(['quoted_spaces', 'quoted_escapes', 'streamed_secret']),
              )
              .max(3),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  })
  .strict();
export type MaintenanceReportPayload = z.infer<
  typeof MaintenanceReportPayloadSchema
>;
export const MaintenanceAssessmentSchema = z
  .object({
    version: z.literal(1),
    classification: z.enum([
      'healthy',
      'configuration_or_environment',
      'suspected_code',
      'synthetic_check',
    ]),
    reason: z.enum([
      'no_failure',
      'requires_diagnosis',
      'registered_probe_needs_central_reproduction',
      'quality_failure_needs_root_cause',
      'synthetic_defect_is_not_source_bug',
    ]),
    repairEligible: z.literal(false),
    sourceTrust: z.literal('installation_assertion'),
  })
  .strict();
export const MaintenanceReportReceiptSchema = z
  .object({
    reportId: UuidSchema,
    deploymentId: UuidSchema,
    sourceReportId: UuidSchema,
    payloadDigest: ChecksumSchema,
    receivedAt: time,
  })
  .strict();
export const MaintenanceReportViewSchema =
  MaintenanceReportReceiptSchema.extend({
    companyName: z.string().min(1).max(80),
    companySlug: z.string().max(48),
    deploymentName: z.string().max(80),
    payload: MaintenanceReportPayloadSchema,
    assessment: MaintenanceAssessmentSchema,
  }).strict();
export const MaintenanceReportPageSchema = z
  .object({
    reports: z.array(MaintenanceReportViewSchema).max(50),
    nextCursor: z.string().max(180).nullable(),
  })
  .strict();
export const MaintenanceConnectionStateSchema = z
  .object({
    deploymentId: UuidSchema,
    credentialRevision: z.number().int().positive(),
    policyRevision: z.number().int().positive(),
    paused: z.boolean(),
    checkIntervalMinutes: z.number().int().min(15).max(10080),
    mode: z.enum(['report_only', 'repair_and_pr']),
    automaticMerge: z.literal(false),
    automaticDeployment: z.literal(false),
  })
  .strict();
export const MaintenanceConnectionFileSchema = z
  .object({
    version: z.literal(1),
    centralUrl: z
      .string()
      .url()
      .refine((s) => {
        const u = new URL(s);
        return (
          u.protocol === 'https:' &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash &&
          u.pathname === '/'
        );
      }, 'An HTTPS origin is required'),
    deploymentId: UuidSchema,
    installationKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
