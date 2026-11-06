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
