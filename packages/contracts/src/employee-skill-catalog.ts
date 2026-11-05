import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  PersonalSkillItemSchema,
  PersonalSkillSourceSchema,
} from './personal-skills.ts';

/** Current instance display projection. Neither this catalog nor its write flags
 * grant authority; every writer and runtime read checks the current source. */
export const EmployeeSkillCatalogSchema = z
  .object({
    instanceId: UuidSchema,
    canInstall: z.boolean(),
    platformSkills: z.array(
      z
        .object({
          kind: z.literal('platform'),
          id: z.string().min(1),
          name: z.string(),
          displayName: z.string(),
          description: z.string(),
          version: z.string().nullable(),
          checksum: ChecksumSchema,
          canUninstall: z.literal(false),
        })
        .strict(),
    ),
    personalSkills: z.array(
      z
        .object({
          kind: z.literal('personal'),
          name: z.string(),
          displayName: z.string(),
          description: z.string(),
          version: z.string().nullable(),
          installationVersion: z.number().int().positive(),
          installationId: UuidSchema,
          versionId: UuidSchema,
          revision: z.number().int().positive(),
          binding: PersonalSkillItemSchema.shape.bindings.element,
          source: PersonalSkillSourceSchema,
          canUninstall: z.boolean(),
          definitionChecksum: ChecksumSchema,
          packageChecksum: ChecksumSchema.optional(),
          resourceCount: PersonalSkillItemSchema.shape.resourceCount,
        })
        .strict(),
    ),
  })
  .strict();
export type EmployeeSkillCatalog = z.infer<typeof EmployeeSkillCatalogSchema>;
