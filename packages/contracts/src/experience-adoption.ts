import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { PersonalSkillSnapshotSchema } from './personal-skills.ts';
import { ExperienceSkillValidationSchema } from './experience-validation.ts';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const SupportedExperienceRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('attendance_groups'), version: z.literal(1) })
    .strict(),
  z
    .object({
      kind: z.literal('report_style'),
      version: z.literal(1),
      style: z.enum(['concise', 'structured']),
    })
    .strict(),
]);

/** Adoption is a policy action, not an assertion that a human reviewed a draft. */
export const ExperienceAdoptionProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    occurrenceId: UuidSchema,
    draftIndex: z.number().int().min(0).max(7),
    instanceId: UuidSchema,
    sourceIds: z.array(UuidSchema).min(1).max(16),
    outputDigest: Digest,
    draftDigest: Digest,
    sourceDigest: Digest,
    rule: SupportedExperienceRuleSchema,
    validation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('independent_skill_case'),
          testId: UuidSchema,
          caseId: z.literal('attendance-roster-v1'),
          caseDigest: Digest,
          dependencies: PersonalSkillSnapshotSchema,
          skillValidation: ExperienceSkillValidationSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('independent_case'),
          testId: UuidSchema,
          caseId: z.literal('attendance-roster-v1'),
          caseDigest: Digest,
        })
        .strict(),
      z
        .object({
          kind: z.literal('direct_preference'),
          evaluator: z.literal('report-style-v1'),
          evidenceDigest: Digest,
        })
        .strict(),
    ]),
    authority: z
      .object({
        kind: z.literal('platform_automatic_experience_policy'),
        revision: z.number().int().positive(),
        digest: Digest,
        authorizedBy: UuidSchema,
      })
      .strict(),
    contentDigest: Digest,
    adoptedAt: TimestampSchema,
  })
  .strict();
export type ExperienceAdoptionProof = z.infer<
  typeof ExperienceAdoptionProofSchema
>;

export const ExperienceReadPinSchema = z
  .object({
    id: UuidSchema,
    revision: z.number().int().positive(),
    instanceId: UuidSchema,
    contentDigest: Digest,
    adoptionDigest: Digest,
  })
  .strict();
export const ExperienceReadPinsSchema = z
  .array(ExperienceReadPinSchema)
  .max(20);
export type ExperienceReadPin = z.infer<typeof ExperienceReadPinSchema>;

export const ExperienceAdoptionViewSchema = z
  .object({
    memoryId: UuidSchema,
    draftIndex: z.number().int().min(0).max(7),
    revision: z.number().int().positive(),
    state: z.enum(['active', 'unavailable', 'forgotten']),
    reason: z.string().max(500).nullable(),
    adoptedAt: TimestampSchema,
    recallCount: z.number().int().nonnegative(),
  })
  .strict();

const compact = (text: string) => text.replace(/[\s，,、。.;；：:]/gu, '');

/** A finite, fully checked rule family. Keyword matching only selects a test;
 * it must never authorize arbitrary model-generated instructions. Both complete
 * clauses must match, including the missing-information restriction. */
export function supportedExperienceRule(draft: {
  rule: string;
  applicability: string;
}) {
  const rule = compact(draft.rule);
  const applicability = compact(draft.applicability);
  if (
    /^(?:统计到场情况时)?(?:依据|根据)原始(?:名单|名册)分别(?:核对|统计)到场和(?:未到|缺席)人数(?:并)?(?:在结果中)?分项列出$/u.test(
      rule,
    ) &&
    /^适用于有原始(?:名单|名册)且到场状态明确的人员统计任务不适用于缺少(?:名单|名册)或状态不明时推算人数$/u.test(
      applicability,
    )
  )
    return { kind: 'attendance_groups' as const, version: 1 as const };
  if (
    /^(?:撰写|编写|输出|交付)报告时(?:采用|使用|保持)(?:分点|分项|条理清晰的)(?:方式|表达|说明)$/u.test(
      rule,
    ) &&
    /^(?:仅|只)适用于报告的表达方式不改变业务规则计算口径或执行步骤$/u.test(
      applicability,
    )
  )
    return {
      kind: 'report_style' as const,
      version: 1 as const,
      style: 'structured' as const,
    };
  if (
    /^(?:撰写|编写|输出|交付)报告时(?:采用|使用|保持)(?:简洁|简短)(?:的)?(?:方式|表达|说明)$/u.test(
      rule,
    ) &&
    /^(?:仅|只)适用于报告的表达方式不改变业务规则计算口径或执行步骤$/u.test(
      applicability,
    )
  )
    return {
      kind: 'report_style' as const,
      version: 1 as const,
      style: 'concise' as const,
    };
  return null;
}

export function experienceAppliesToRequest(
  rule: ExperienceAdoptionProof['rule'],
  text: string,
) {
  return rule.kind === 'report_style'
    ? /报告/u.test(text)
    : rule.kind === 'attendance_groups' &&
        /(?:到场|签到|缺席|未到)/u.test(text) &&
        /(?:名单|名册|人数|统计|核对)/u.test(text);
}

/** Quoted source material cannot authorize a write. Target resolution remains
 * server-side and must match a current, private instance-bound memory. */
export function explicitExperienceForgetRequest(text: string): string | null {
  // Entire request must be a direct imperative. The quoted target is data,
  // never a nested instruction. Do not infer deletion from document text,
  // negation, temporary requirements, or an assistant's chosen memory ID.
  const match = text
    .trim()
    .match(
      /^(?:请|帮我|请帮我)?(?:忘记|忘掉|删除|撤回|撤销)(?:你(?:自动)?整理的|已整理的)?[“「"]([^”」"\n]{1,4000})[”」"](?:这条)?(?:个人)?(?:经验|记忆)[，,。！.!]?(?:\s*以后不要自动采用[。！.!]?)?$/u,
    );
  return match?.[1]?.trim() ?? null;
}

/** Lightweight preference evidence proves a narrow expression choice only. */
export function supportsDirectReportPreference(
  style: 'concise' | 'structured',
  excerpts: string[],
) {
  return (
    excerpts.length > 0 &&
    excerpts.every((text) => {
      const normalized = compact(text);
      const expression =
        style === 'structured' ? '(?:分点|分项|条理清晰)' : '(?:简洁|简短)';
      return new RegExp(
        `^(?:反馈|我已核对)?(?:这份|本次的|这个)?报告${expression}(?:说明|表达)?(?:很)?(?:清晰|方便|合适)(?:阅读起来很方便)?$`,
        'u',
      ).test(normalized);
    })
  );
}
export const ExperienceActionReceiptSchema = z
  .object({
    action: z.literal('forget'),
    status: z.enum([
      'forgotten',
      'already_forgotten',
      'not_found',
      'ambiguous',
    ]),
    memoryId: UuidSchema.nullable(),
    target: z.string().min(1).max(4000),
  })
  .strict();
