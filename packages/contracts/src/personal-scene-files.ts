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
    if (file.scene.nativeName !== `allrice-scene-${file.scene.id}`)
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
        bundle: SkillBundleSchema.omit({ resources: true }),
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
