import { z } from 'zod';
import {
  UuidSchema,
  ProjectVersionRefSchema,
  BrowserVerificationOutcomeSchema,
  ProjectServiceTargetSchema,
} from '@allrice/contracts';

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime({ offset: true });
export const CreateQualityCheckSchema = z
  .object({
    requestId: UuidSchema,
    caseId: z.enum(['project.static.v1', 'project.live.v1']),
    variant: z.enum(['defect', 'correct']),
  })
  .strict();
export type CreateQualityCheck = z.infer<typeof CreateQualityCheckSchema>;
export const QualityLiveEvidenceSchema = z
  .object({
    version: z.literal(1),
    checkId: UuidSchema,
    runId: UuidSchema,
    jobId: UuidSchema,
    jobAttempt: z.number().int().positive(),
    toolCallId: z.string().min(1).max(255),
    browserTaskId: UuidSchema,
    service: ProjectServiceTargetSchema,
    originalProject: ProjectVersionRefSchema,
    updatedProject: ProjectVersionRefSchema,
    updateId: UuidSchema,
    sourceDigest: checksum,
    httpStatus: z.literal(200),
    websocketStatus: z.literal(101),
    websocketProtocol: z.literal('vite-hmr'),
    connectedFrame: z.literal(true),
    updateFrame: z.literal(true),
    beforeText: z.literal('source:42'),
    afterText: z.literal('source:43'),
    mainFrameNavigations: z.literal(0),
    timeOriginUnchanged: z.literal(true),
    browserVersion: z.string().min(1).max(120),
    browserStopConfirmed: z.literal(true),
    snapshotChecksum: checksum,
    screenshotChecksum: checksum,
  })
  .strict();
export type QualityLiveEvidence = z.infer<typeof QualityLiveEvidenceSchema>;
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
export const QualityVerdictSchema = z.enum([
  'passed',
  'assertion_failed',
  'blocked',
  'execution_failed',
  'canceled',
  'unknown',
]);
export const QualityCheckReportSchema = z
  .object({
    version: z.literal(1),
    verdict: QualityVerdictSchema,
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
    live: QualityLiveEvidenceSchema.optional(),
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
      !r.live &&
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
    if (
      r.live &&
      (r.verdict !== 'passed' ||
        r.build !== null ||
        r.browser !== null ||
        !r.project ||
        r.project.snapshot.id !== r.live.updatedProject.snapshot.id ||
        !r.artifacts.some((a) => a.kind === 'source') ||
        !r.artifacts.some((a) => a.kind === 'report') ||
        !r.artifacts.some((a) => a.kind === 'screenshot') ||
        r.cleanup !== 'pending')
    )
      ctx.addIssue({
        code: 'custom',
        message:
          'Live evidence must retain its finite service lease separately from the closed browser',
      });
  });
export const QualityCheckSchema = z
  .object({
    id: UuidSchema,
    requestId: UuidSchema,
    runId: UuidSchema,
    jobId: UuidSchema,
    sessionId: UuidSchema,
    caseId: CreateQualityCheckSchema.shape.caseId,
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

// This is a persisted delegation, never proof of a browser login. Scheduled
// live cases are intentionally absent from this private server contract.
export const QualityScheduleOriginSchema = z
  .object({
    version: z.literal(1),
    automationId: UuidSchema,
    occurrenceId: UuidSchema,
    revision: z.number().int().positive(),
    ownerId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    caseId: z.literal('project.static.v1'),
    variant: z.literal('correct'),
    scheduledFor: time,
    dispatchDeadlineAt: time,
    configurationDigest: checksum,
  })
  .strict();
export type QualityScheduleOrigin = z.infer<typeof QualityScheduleOriginSchema>;
export const UpdateQualityScheduleSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  })
  .strict();
export const QualityScheduleViewSchema = z
  .object({
    schedule: z
      .object({
        id: UuidSchema,
        revision: z.number().int().positive(),
        enabled: z.boolean(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        timezone: z.literal('Asia/Shanghai'),
        nextRunAt: time.nullable(),
      })
      .strict()
      .nullable(),
    occurrences: z
      .array(
        z
          .object({
            id: UuidSchema,
            scheduledFor: time,
            status: z.enum([
              'queued',
              'running',
              'succeeded',
              'failed',
              'canceled',
            ]),
            checkId: UuidSchema.nullable(),
            accepted: z.boolean(),
            verdict: QualityVerdictSchema.nullable(),
            notExecutedReason: z
              .string()
              .regex(/^[A-Z0-9_]{1,100}$/)
              .nullable(),
          })
          .strict()
          .refine(
            (o) =>
              !o.accepted ||
              (o.status === 'succeeded' &&
                o.verdict === 'passed' &&
                !!o.checkId),
          ),
      )
      .max(20),
  })
  .strict();
export type QualityScheduleView = z.infer<typeof QualityScheduleViewSchema>;
