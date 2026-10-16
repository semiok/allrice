import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';

export const experienceRosterCase = {
  id: 'attendance-roster-v1' as const,
  version: 1,
  coverage:
    '仅验证这份草稿在四个合成名单样例中的分组计数和缺失信息处理；不证明原任务名单或其他业务场景正确，尚未启用。',
  samples: [
    {
      id: 'complete-a',
      roster: [
        { id: 'A01', status: 'present' },
        { id: 'A02', status: 'absent' },
        { id: 'A03', status: 'present' },
        { id: 'A04', status: 'present' },
        { id: 'A05', status: 'absent' },
        { id: 'A06', status: 'absent' },
        { id: 'A07', status: 'present' },
      ],
    },
    {
      id: 'complete-b',
      roster: [
        { id: 'B01', status: 'absent' },
        { id: 'B02', status: 'present' },
        { id: 'B03', status: 'absent' },
        { id: 'B04', status: 'absent' },
        { id: 'B05', status: 'present' },
      ],
    },
    {
      id: 'unknown-status',
      roster: [
        { id: 'C01', status: 'present' },
        { id: 'C02', status: 'unknown' },
        { id: 'C03', status: 'absent' },
      ],
    },
    { id: 'no-roster', roster: null },
  ],
} as const;

const ResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      id: z.string(),
      status: z.literal('counted'),
      present: z
        .object({
          count: z.number().int().nonnegative(),
          ids: z.array(z.string()).max(20),
        })
        .strict(),
      absent: z
        .object({
          count: z.number().int().nonnegative(),
          ids: z.array(z.string()).max(20),
        })
        .strict(),
      total: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ id: z.string(), status: z.literal('needs_information') }).strict(),
]);
export const ExperienceRosterAnswerSchema = z
  .object({
    results: z.array(ResultSchema).length(experienceRosterCase.samples.length),
  })
  .strict();
export const ExperienceValidationAssertionSchema = z
  .object({
    caseId: z.literal(experienceRosterCase.id),
    passed: z.boolean(),
    reason: z.enum([
      'matched',
      'invalid_output',
      'count_or_membership_mismatch',
      'missing_information_inferred',
      'execution_failed',
      'authority_changed',
    ]),
    checks: z
      .array(z.object({ id: z.string(), passed: z.boolean() }).strict())
      .max(4),
  })
  .strict();
export type ExperienceValidationAssertion = z.infer<
  typeof ExperienceValidationAssertionSchema
>;

/** Only the server owns the reference calculation. Model self-evaluation is ignored. */
export function evaluateExperienceRoster(
  answer: string | null,
  failed = false,
): ExperienceValidationAssertion {
  const base = { caseId: experienceRosterCase.id, passed: false, checks: [] };
  if (failed) return { ...base, reason: 'execution_failed' };
  let parsed: z.infer<typeof ExperienceRosterAnswerSchema>;
  try {
    if (!answer || answer.length > 12000) throw Error('invalid');
    parsed = ExperienceRosterAnswerSchema.parse(JSON.parse(answer));
  } catch {
    return { ...base, reason: 'invalid_output' };
  }
  const results = new Map(parsed.results.map((r) => [r.id, r]));
  if (
    results.size !== experienceRosterCase.samples.length ||
    experienceRosterCase.samples.some((s) => !results.has(s.id))
  )
    return { ...base, reason: 'invalid_output' };
  let reason: ExperienceValidationAssertion['reason'] = 'matched';
  const checks = experienceRosterCase.samples.map((sample) => {
    const actual = results.get(sample.id)!;
    const incomplete =
      sample.roster === null ||
      sample.roster.some((row) => row.status === 'unknown');
    if (incomplete) {
      const passed = actual.status === 'needs_information';
      if (!passed) reason = 'missing_information_inferred';
      return { id: sample.id, passed };
    }
    const present = sample
      .roster!.filter((row) => row.status === 'present')
      .map((row) => row.id)
      .sort();
    const absent = sample
      .roster!.filter((row) => row.status === 'absent')
      .map((row) => row.id)
      .sort();
    const passed =
      actual.status === 'counted' &&
      actual.present.count === present.length &&
      actual.absent.count === absent.length &&
      actual.total === sample.roster!.length &&
      JSON.stringify([...actual.present.ids].sort()) ===
        JSON.stringify(present) &&
      JSON.stringify([...actual.absent.ids].sort()) === JSON.stringify(absent);
    if (!passed && reason === 'matched')
      reason = 'count_or_membership_mismatch';
    return { id: sample.id, passed };
  });
  return {
    caseId: experienceRosterCase.id,
    passed: checks.every((c) => c.passed),
    reason,
    checks,
  };
}

export const ExperienceValidationViewSchema = z
  .object({
    id: UuidSchema,
    draftIndex: z.number().int().min(0).max(7),
    caseId: z.literal(experienceRosterCase.id),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    validationStatus: z.enum(['pending', 'passed', 'failed', 'not_verified']),
    runId: UuidSchema.nullable(),
    createdAt: TimestampSchema,
    completedAt: TimestampSchema.nullable(),
    assertion: ExperienceValidationAssertionSchema.nullable(),
    outputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    coverage: z.literal(experienceRosterCase.coverage),
    active: z.literal(false),
  })
  .strict();
