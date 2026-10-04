import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

/** Only a saved immutable HTML version. Models never supply URLs or bytes. */
export const StaticBrowserReferenceSchema = z
  .object({
    versionId: UuidSchema,
    checksum: ChecksumSchema,
  })
  .strict();
export const staticBrowserMaximumBytes = 100_000;
export const staticBrowserImageV1 =
  'sha256:1ee8ab3b8bb7b2dc61c8095f5f59d03b7d51b75b9fcf852ca8bd2f2a1fca7a0e';
export const StaticBrowserTargetSchema = StaticBrowserReferenceSchema.extend({
  version: z.literal(1),
  objectId: UuidSchema,
  sizeBytes: z.number().int().positive().max(staticBrowserMaximumBytes),
  mediaType: z.literal('text/html'),
  fileName: z.string().min(1).max(120),
  sourceOperationId: UuidSchema.nullable(),
  sourceSessionId: UuidSchema,
}).strict();
export type StaticBrowserTarget = z.infer<typeof StaticBrowserTargetSchema>;
export const staticBrowserDocumentUrl = (
  target: Pick<StaticBrowserTarget, 'checksum'>,
) =>
  `https://saved-${ChecksumSchema.parse(target.checksum).slice(7, 39)}.allrice-static.invalid/${target.checksum.slice(7)}/index.html`;
export function reservedStaticBrowserUrl(value: string) {
  try {
    return new URL(value).hostname.endsWith('.allrice-static.invalid');
  } catch {
    return false;
  }
}
/** Authenticated Bridge/backend transport only, never a tool argument. */
export const StaticBrowserDocumentSchema = z
  .object({
    target: StaticBrowserTargetSchema,
    contentBase64: z.string().min(4).max(133_336),
  })
  .strict();
export type StaticBrowserDocument = z.infer<typeof StaticBrowserDocumentSchema>;

const selector = z
  .object({
    tag: z.enum(['a', 'button', 'input', 'textarea', 'select']),
    label: z.string().min(1).max(200),
  })
  .strict();
const step = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector }).strict(),
  z
    .object({ type: z.literal('fill'), selector, value: z.string().max(4000) })
    .strict(),
  z
    .object({
      type: z.literal('text_contains'),
      expected: z.string().min(1).max(500),
    })
    .strict(),
  z
    .object({ type: z.literal('title_equals'), expected: z.string().max(200) })
    .strict(),
]);
export const BrowserVerificationPlanSchema = z
  .object({
    version: z.literal(1),
    timeoutMs: z.number().int().min(1000).max(60_000).default(30_000),
    steps: z.array(step).min(1).max(16),
  })
  .strict()
  .refine(
    (p) =>
      p.steps.some(
        (s) => s.type === 'text_contains' || s.type === 'title_equals',
      ),
    'At least one deterministic assertion is required',
  );
export type BrowserVerificationPlan = z.infer<
  typeof BrowserVerificationPlanSchema
>;
export const BrowserVerificationStepResultSchema = z
  .object({
    index: z.number().int().min(0).max(15),
    type: z.enum(['click', 'fill', 'text_contains', 'title_equals']),
    status: z.enum(['completed', 'passed', 'failed', 'unknown']),
    observationId: UuidSchema.nullable(),
    pageDigest: ChecksumSchema.nullable(),
    expected: z.string().max(500).nullable(),
    actual: z.string().max(2000).nullable(),
    errorCode: z.string().max(120).nullable(),
  })
  .strict();
export const BrowserVerificationReportSchema = z
  .object({
    version: z.literal(1),
    target: StaticBrowserTargetSchema,
    planDigest: ChecksumSchema,
    startedAt: TimestampSchema,
    completedAt: TimestampSchema,
    verdict: z.enum(['passed', 'failed', 'unknown']),
    steps: z.array(BrowserVerificationStepResultSchema).max(16),
    errorCode: z.string().max(120).nullable(),
  })
  .strict();
export type BrowserVerificationReport = z.infer<
  typeof BrowserVerificationReportSchema
>;

export const BrowserVerificationOutcomeSchema = z
  .object({
    version: z.literal(1),
    verificationId: UuidSchema,
    report: BrowserVerificationReportSchema,
    plan: BrowserVerificationPlanSchema,
    location: z.enum(['local', 'cloud']),
    executionReason: z.string().max(120),
    targetId: UuidSchema,
    deviceId: UuidSchema.nullable(),
    attemptId: UuidSchema,
    containerId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    imageDigest: ChecksumSchema.nullable(),
    browserVersion: z.string().min(1).max(100),
    physicalStopConfirmed: z.literal(true),
    screenshotChecksum: ChecksumSchema,
    screenshotObjectId: UuidSchema.nullable(),
    screenshotObservationId: UuidSchema,
  })
  .strict()
  .refine(
    (v) =>
      (v.location === 'local') === (v.deviceId !== null) &&
      (v.location !== 'cloud' ||
        (v.containerId !== null && v.imageDigest !== null)),
    'Physical backend identity required',
  )
  .refine(
    (v) =>
      browserVerificationMatchesPlan(v.report, v.plan) &&
      (v.report.verdict === 'unknown' ||
        !v.report.steps.length ||
        v.report.steps.at(-1)?.observationId === v.screenshotObservationId),
    'Incomplete verification report',
  );
export type BrowserVerificationOutcome = z.infer<
  typeof BrowserVerificationOutcomeSchema
>;
export const ArtifactBrowserVerificationSchema = z
  .object({
    outcome: BrowserVerificationOutcomeSchema,
    reportArtifactId: UuidSchema,
    screenshotArtifactId: UuidSchema,
  })
  .strict();
export type ArtifactBrowserVerification = z.infer<
  typeof ArtifactBrowserVerificationSchema
>;

/** A truncated/crashed/partial execution cannot be represented as passed. */
export function browserVerificationMatchesPlan(
  report: BrowserVerificationReport,
  plan: BrowserVerificationPlan,
) {
  if (
    report.verdict === 'passed' &&
    (report.errorCode !== null || report.steps.length !== plan.steps.length)
  )
    return false;
  return report.steps.every((r, i) => {
    const step = plan.steps[i];
    if (!step || r.index !== i || r.type !== step.type) return false;
    const assertion =
      step.type === 'text_contains' || step.type === 'title_equals';
    if (r.expected !== (assertion ? step.expected : null)) return false;
    return (
      report.verdict !== 'passed' ||
      (r.errorCode === null &&
        r.status === (assertion ? 'passed' : 'completed') &&
        r.observationId !== null &&
        r.pageDigest !== null)
    );
  });
}
