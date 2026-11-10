import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { SkillBundleSchema } from './skill-bundle.ts';
import { EmployeeSceneSkillPayloadSchema } from './employee-content.ts';
import {
  PersonalSceneContentRefSchema,
  PersonalSceneSkillSchema,
  SavePersonalSceneSkillSchema,
} from './employee-scene-skills.ts';

/** D0's portable output. Its report is author metadata, never permission or
 * checksum evidence; the server validates the actual procedure and bytes. */
export const PersonalSceneFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    scene: SavePersonalSceneSkillSchema.shape.scene.extend({
      nativeName: z.string(),
    }),
    procedure: SavePersonalSceneSkillSchema.shape.procedure,
    references: SavePersonalSceneSkillSchema.shape.references.refine(
      (refs) =>
        refs.every(
          (ref) =>
            !['procedure', 'requirement', 'workflow'].includes(ref.sourceKind),
        ),
      'Requirements belong in the packaged body.',
    ),
    report: z.unknown().optional(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const authorName =
      'skillPackage' in file.procedure
        ? file.procedure.skillPackage.frontmatter?.name
        : undefined;
    // D0 files made before native-name wiring remain readable. A supplied name
    // never selects a package: exact scene/source identities are rechecked.
    if (
      file.scene.nativeName !== `allrice-scene-${file.scene.id}` &&
      file.scene.nativeName !== authorName
    )
      ctx.addIssue({
        code: 'custom',
        path: ['scene', 'nativeName'],
        message: 'The native name must identify the selected scene.',
      });
  });
export type PersonalSceneFile = z.infer<typeof PersonalSceneFileSchema>;

export const PreviewPersonalSceneFileSchema = z
  .object({ workspaceId: UuidSchema, file: PersonalSceneFileSchema })
  .strict();

export const PersonalSceneFilePreviewSchema = z
  .object({
    instanceId: UuidSchema,
    instanceName: z.string(),
    expectedRevision: z.number().int().nonnegative(),
    expectedContentRef: PersonalSceneContentRefSchema.nullable(),
    file: PersonalSceneFileSchema,
    current: PersonalSceneSkillSchema.nullable(),
    currentMetadata: z
      .object({
        title: z.string(),
        // The complete bundle is validated by the existing package reader.
        // Metadata is a projection: omitting resources from the refined full
        // schema would discard the input required by its cross-field checks.
        bundle: z
          .object({
            schemaVersion: SkillBundleSchema.shape.schemaVersion,
            version: SkillBundleSchema.shape.version,
            checksum: SkillBundleSchema.shape.checksum,
            contentChecksum: SkillBundleSchema.shape.contentChecksum,
            sourceRef: SkillBundleSchema.shape.sourceRef,
            license: SkillBundleSchema.shape.license,
            reviewedBy: SkillBundleSchema.shape.reviewedBy,
            dependencies: SkillBundleSchema.shape.dependencies,
          })
          .strict(),
        resourceSources: EmployeeSceneSkillPayloadSchema.shape.resourceSources,
      })
      .strict()
      .nullable(),
    currentScene: SavePersonalSceneSkillSchema.shape.scene
      .extend({ references: SavePersonalSceneSkillSchema.shape.references })
      .nullable(),
  })
  .strict();
export type PersonalSceneFilePreview = z.infer<
  typeof PersonalSceneFilePreviewSchema
>;

/** Exact historical selection. A preview is not authority to restore bytes. */
export const PreviewPersonalSceneRestoreSchema = z
  .object({
    workspaceId: UuidSchema,
    restoreContentRef: PersonalSceneContentRefSchema,
  })
  .strict();
export const PersonalSceneRestorePreviewSchema =
  PersonalSceneFilePreviewSchema.extend({
    // Restore retains the original package ref as well as its sources. Show
    // every exact reference it will retain; portable imports stay stricter.
    file: z
      .object({
        ...PersonalSceneFileSchema.shape,
        references: SavePersonalSceneSkillSchema.shape.references,
      })
      .strict(),
    restoreContentRef: PersonalSceneContentRefSchema,
    restoreRevision: z.number().int().positive(),
  }).strict();
export type PersonalSceneRestorePreview = z.infer<
  typeof PersonalSceneRestorePreviewSchema
>;
export const RestorePersonalSceneFileSchema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedContentRef: PersonalSceneContentRefSchema.nullable(),
    restoreContentRef: PersonalSceneContentRefSchema,
    sceneId: UuidSchema,
    contentChecksum: ChecksumSchema,
    bundleChecksum: ChecksumSchema,
    changeSummary: SavePersonalSceneSkillSchema.shape.changeSummary,
  })
  .strict();
export type RestorePersonalSceneFile = z.infer<
  typeof RestorePersonalSceneFileSchema
>;

export const PersonalSceneFileHistoryQuerySchema = z
  .object({
    workspaceId: UuidSchema.optional(),
    beforeRevision: z.coerce.number().int().positive().optional(),
  })
  .strict();
export const PersonalSceneFileHistorySchema = z
  .object({
    instanceId: UuidSchema,
    revision: z.number().int().nonnegative(),
    entries: z.array(
      z
        .object({
          sceneId: UuidSchema,
          name: z.string(),
          revision: z.number().int().positive(),
          contentRef: PersonalSceneContentRefSchema,
          changeSummary: z.string(),
          createdAt: TimestampSchema,
          available: z.boolean(),
          contentChecksum: ChecksumSchema.optional(),
          bundleChecksum: ChecksumSchema.optional(),
        })
        .strict(),
    ),
    nextBeforeRevision: z.number().int().positive().nullable(),
  })
  .strict();
export type PersonalSceneFileHistory = z.infer<
  typeof PersonalSceneFileHistorySchema
>;
