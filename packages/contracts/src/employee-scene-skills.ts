import { z } from 'zod';
import { UuidSchema, TimestampSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { SkillResourcePathSchema } from './skill-bundle.ts';
import {
  EmployeeContentManifestSchema,
  EmployeeContentOwnershipSchema,
  EmployeeContentReferenceSchema,
  EmployeeSceneSkillPayloadSchema,
} from './employee-content.ts';

/** These are immutable content locators, not execution or authorization tokens. */
export const EmployeeSceneSkillPinSchema = z
  .object({
    setId: UuidSchema,
    revisionId: UuidSchema,
    sceneId: UuidSchema,
    sourceRevisionId: UuidSchema,
  })
  .strict();
export type EmployeeSceneSkillPin = z.infer<typeof EmployeeSceneSkillPinSchema>;

export const EmployeeSceneSkillResourceDescriptorSchema = z
  .object({
    path: SkillResourcePathSchema,
    mediaType: z.string(),
    byteLength: z.number().int().nonnegative(),
    checksum: ChecksumSchema,
  })
  .strict();

export const EmployeeSceneSkillSummarySchema = z
  .object({
    pin: EmployeeSceneSkillPinSchema,
    ownership: EmployeeContentOwnershipSchema,
    publication: z
      .object({
        number: z.number().int().positive(),
        digest: ChecksumSchema,
        publishedAt: TimestampSchema,
      })
      .strict(),
    scene: EmployeeContentManifestSchema.shape.scenes.element,
    common: z.array(EmployeeContentReferenceSchema),
    source: z
      .object({
        reference: EmployeeContentReferenceSchema,
        number: z.number().int().positive(),
        createdBy: UuidSchema,
        createdAt: TimestampSchema,
      })
      .strict(),
    bundleVersion: z.string(),
    bundleChecksum: ChecksumSchema,
    contentChecksum: ChecksumSchema,
    resources: z.array(EmployeeSceneSkillResourceDescriptorSchema),
  })
  .strict();
export const EmployeeSceneSkillCatalogSchema = z
  .object({
    instanceId: UuidSchema,
    employeeId: UuidSchema,
    // Company, current department, personal; entries never replace an upstream package.
    skills: z.array(EmployeeSceneSkillSummarySchema),
  })
  .strict();
export const EmployeePublishedSceneSkillSchema =
  EmployeeSceneSkillSummarySchema.extend({
    content: z.string(),
    skillPackage: EmployeeSceneSkillPayloadSchema,
  });
export type EmployeePublishedSceneSkill = z.infer<
  typeof EmployeePublishedSceneSkillSchema
>;
export type EmployeeSceneSkillCatalog = z.infer<
  typeof EmployeeSceneSkillCatalogSchema
>;
