import { z } from 'zod';
import { UuidSchema, TimestampSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { SkillResourcePathSchema } from './skill-bundle.ts';
import {
  EmployeeContentManifestSchema,
  EmployeeContentOwnershipSchema,
  EmployeeContentReferenceSchema,
  EmployeeSceneSkillPayloadSchema,
  EmployeeContentTextSchema,
  employeeContentLimits,
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

/** A serializable content address. Possession is never authorization. The
 * storage implementation owns its encoding; callers must not construct pins. */
export const PersonalSceneContentRefSchema = z.string().min(1).max(512);
export const PersonalSceneSkillSummarySchema = z
  .object({
    sceneId: UuidSchema,
    name: z.string(),
    description: z.string(),
    nativeName: z.string(),
  })
  .strict();
export const PersonalSceneSkillSchema = PersonalSceneSkillSummarySchema.extend({
  contentRef: PersonalSceneContentRefSchema,
  revision: z.number().int().positive(),
  content: z.string(),
  contentChecksum: ChecksumSchema,
  bundleVersion: z.string(),
  bundleChecksum: ChecksumSchema,
  resources: z.array(EmployeeSceneSkillResourceDescriptorSchema),
  sources: z.array(
    z
      .object({ reference: EmployeeContentReferenceSchema, title: z.string() })
      .strict(),
  ),
});
export type PersonalSceneSkill = z.infer<typeof PersonalSceneSkillSchema>;
export const PersonalSceneSkillCatalogSchema = z
  .object({
    instanceId: UuidSchema,
    revision: z.number().int().nonnegative(),
    skills: z.array(PersonalSceneSkillSummarySchema),
  })
  .strict();
export const PersonalSceneSkillResourceSchema =
  EmployeeSceneSkillResourceDescriptorSchema.extend({
    contentRef: PersonalSceneContentRefSchema,
    bundleChecksum: ChecksumSchema,
    contentBase64: z.string(),
  });
export const PersonalSceneSkillQuerySchema = z
  .object({
    workspaceId: UuidSchema.optional(),
    sceneId: UuidSchema.optional(),
    contentRef: PersonalSceneContentRefSchema.optional(),
    resourcePath: SkillResourcePathSchema.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (
      (query.sceneId && (query.contentRef || query.resourcePath)) ||
      Boolean(query.contentRef) !== Boolean(query.resourcePath)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Select a scene or an exact resource.',
      });
  });

/** No scope, owner, publication controls or execution permission are inputs. */
export const SavePersonalSceneSkillSchema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedContentRef: PersonalSceneContentRefSchema.nullable(),
    scene: EmployeeContentManifestSchema.shape.scenes.element.omit({
      references: true,
    }),
    procedure: EmployeeContentTextSchema.refine(
      (text) => text.kind === 'procedure' && 'skillPackage' in text,
      'A complete packaged procedure is required.',
    ),
    references: z
      .array(EmployeeContentReferenceSchema)
      .max(employeeContentLimits.references),
    changeSummary: z.string().trim().min(1).max(1000),
  })
  .strict();
export type SavePersonalSceneSkill = z.infer<
  typeof SavePersonalSceneSkillSchema
>;
export const PersonalSceneSkillSaveReceiptSchema = z
  .object({
    instanceId: UuidSchema,
    sceneId: UuidSchema,
    revision: z.number().int().positive(),
    contentRef: PersonalSceneContentRefSchema,
    contentChecksum: ChecksumSchema,
    bundleChecksum: ChecksumSchema,
  })
  .strict();

/** Resource locators do not confer authority. Legacy names and exact personal
 * package addresses are disjoint, so neither can silently fall back to latest. */
export const SkillResourceReadSchema = z.union([
  z.object({ skill: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), path: SkillResourcePathSchema }).strict(),
  z.object({ contentRef: PersonalSceneContentRefSchema, path: SkillResourcePathSchema }).strict(),
]);
export type PersonalSceneSkillResource = z.infer<typeof PersonalSceneSkillResourceSchema>;
