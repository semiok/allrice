import { z } from 'zod';
import { ChecksumSchema } from './runs.ts';
import {
  PersonalSkillGitHubSourceSchema,
  personalSkillLimits,
} from './personal-skills.ts';

/** Provenance for frozen source bytes, never a storage or permission grant. */
export const SkillPackageSourceSchema = z.union([
  PersonalSkillGitHubSourceSchema,
  z
    .object({
      kind: z.literal('zip'),
      fileName: z.string().min(1).max(255),
      originalChecksum: ChecksumSchema,
      byteLength: z
        .number()
        .int()
        .positive()
        .max(personalSkillLimits.archiveBytes),
    })
    .strict(),
]);
export type SkillPackageSource = z.infer<typeof SkillPackageSourceSchema>;

/** Stable technical projection for the existing browser error envelope. */
export const skillSourceErrorHeader = 'X-AllRice-Skill-Error';
export const SkillSourceErrorReasonSchema = z.enum([
  'skill_missing',
  'package_invalid',
  'workflow_invalid',
  'source_unavailable',
  'name_mismatch',
  'name_conflict',
  'version_conflict',
  'limit',
  'preview_invalid',
  'preview_expired',
]);
export type SkillSourceErrorReason = z.infer<
  typeof SkillSourceErrorReasonSchema
>;
