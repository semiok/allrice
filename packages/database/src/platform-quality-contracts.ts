import { z } from 'zod';
import {
  UuidSchema,
  ProjectVersionRefSchema,
  BrowserVerificationOutcomeSchema,
} from '@allrice/contracts';

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime({ offset: true });
export const CreateQualityCheckSchema = z
  .object({
    requestId: UuidSchema,
    caseId: z.literal('project.static.v1'),
    variant: z.enum(['defect', 'correct']),
  })
  .strict();
export type CreateQualityCheck = z.infer<typeof CreateQualityCheckSchema>;
export const QualityArtifactSchema = z
  .object({
    artifactId: UuidSchema,
    versionId: UuidSchema,
    objectId: UuidSchema,
    checksum,
    fileName: z.string().min(1).max(120),
    sizeBytes: z.number().int().nonnegative().max(2_000_000),
    kind: z.enum(['source', 'page', 'report', 'screenshot']),
    storedBytesVerified: z.literal(true),
  })
  .strict();
export const QualityCheckReportSchema = z
  .object({
    version: z.literal(1),
    verdict: z.enum([
      'passed',
      'assertion_failed',
      'blocked',
      'execution_failed',
      'canceled',
      'unknown',
    ]),
    completedAt: time,
    project: ProjectVersionRefSchema.nullable(),
    build: z
      .object({
        operationId: UuidSchema,
        location: z.enum(['local', 'cloud']),
        targetId: UuidSchema,
        exitCode: z.number().int().nullable(),
        command: z.literal('node build.mjs'),
      })
      .strict()
      .nullable(),
    artifacts: z.array(QualityArtifactSchema).max(8),
    browser: BrowserVerificationOutcomeSchema.nullable(),
    errorCode: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{1,120}$/)
      .nullable(),
    cleanup: z.enum(['confirmed', 'pending', 'unknown']),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (
      ['passed', 'assertion_failed'].includes(r.verdict) &&
      (!r.project ||
        r.build?.exitCode !== 0 ||
        !r.browser ||
        !r.artifacts.some((a) => a.kind === 'source') ||
        !r.artifacts.some((a) => a.kind === 'page') ||
        !r.artifacts.some((a) => a.kind === 'screenshot') ||
        r.browser.report.verdict !==
          (r.verdict === 'passed' ? 'passed' : 'failed') ||
        r.cleanup !== 'confirmed')
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'A completed check requires actual build, published bytes, browser assertions and confirmed stop',
      });
  });
export const QualityCheckSchema = z
  .object({
    id: UuidSchema,
    requestId: UuidSchema,
    runId: UuidSchema,
    jobId: UuidSchema,
    sessionId: UuidSchema,
    caseId: z.literal('project.static.v1'),
    variant: CreateQualityCheckSchema.shape.variant,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    environment: z.enum(['dev', 'prod', 'test', 'unknown']),
    releaseSha: z.string().regex(/^[a-f0-9]{40}$/),
    fixtureDigest: checksum,
    assertionDigest: checksum,
    runnerDigest: checksum,
    fingerprint: checksum,
    employeeVersionId: UuidSchema,
    employeeRevisionId: UuidSchema,
    modelUsed: z.literal(false),
    accepted: z.boolean(),
    createdAt: time,
    report: QualityCheckReportSchema.nullable(),
  })
  .strict()
  .refine(
    (q) =>
      q.accepted ===
      (q.status === 'succeeded' && q.report?.verdict === 'passed'),
    'Acceptance requires the successful canonical Job and complete passed evidence',
  );
export type QualityCheck = z.infer<typeof QualityCheckSchema>;
export type QualityCheckReport = z.infer<typeof QualityCheckReportSchema>;
