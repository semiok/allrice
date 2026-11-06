import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { WorkflowSkillFrontmatterSchema } from './workflow-skill.ts';
import { PersonalSkillDefinitionSchema } from './personal-skills.ts';
import {
  PersonalSceneContentRefSchema,
  PersonalSceneSkillSchema,
  PersonalSceneSkillSaveReceiptSchema,
} from './employee-scene-skills.ts';
import {
  PersonalSkillPreviewAttestationSchema,
  PersonalSkillPreviewRequestSchema,
  PersonalSkillConfirmRequestSchema,
  PersonalSkillPreviewResponseSchema,
} from './personal-skill-browser.ts';

export const PersonalScenePreviewTargetSchema = z.discriminatedUnion(
  'operation',
  [
    z.object({ operation: z.literal('install') }).strict(),
    z
      .object({
        operation: z.literal('update'),
        sceneId: UuidSchema,
        expectedRevision: z.number().int().positive(),
        expectedContentRef: PersonalSceneContentRefSchema,
      })
      .strict(),
  ],
);
const committedTarget = z
  .object({
    operation: z.enum(['install', 'update']),
    sceneId: UuidSchema,
    expectedRevision: z.number().int().nonnegative(),
    expectedContentRef: PersonalSceneContentRefSchema.nullable(),
  })
  .strict();
export const PersonalScenePreviewAttestationSchema =
  PersonalSkillPreviewAttestationSchema.omit({ target: true })
    .extend({ target: committedTarget })
    .strict();
export const PersonalScenePreviewRequestSchema =
  PersonalSkillPreviewRequestSchema.omit({ target: true })
    .extend({ target: PersonalScenePreviewTargetSchema })
    .strict();
export const PersonalSceneConfirmRequestSchema =
  PersonalSkillConfirmRequestSchema;
export const PersonalScenePreviewResponseSchema = z
  .object({
    instanceId: UuidSchema,
    instanceName: z.string(),
    operation: z.enum(['install', 'update']),
    previewId: z.string().min(1),
    digest: ChecksumSchema,
    expiresAt: PersonalScenePreviewAttestationSchema.shape.expiresAt,
    target: committedTarget,
    item: z
      .object({
        frontmatter: WorkflowSkillFrontmatterSchema,
        content: PersonalSkillDefinitionSchema.shape.content,
        stepsMarkdown: z.string(),
        deliverablesMarkdown: z.string(),
      })
      .strict(),
    current: PersonalSceneSkillSchema.nullable(),
    source: PersonalScenePreviewAttestationSchema.shape.source,
    files: PersonalSkillPreviewResponseSchema.shape.files,
    effectiveFrom: z.literal('next_load'),
    installed: z.literal(false),
    scriptsExecuted: z.literal(false),
  })
  .strict();
export const PersonalSceneConfirmReceiptSchema =
  PersonalSceneSkillSaveReceiptSchema.extend({
    operation: z.enum(['install', 'update']),
    requestId: UuidSchema,
    source: PersonalScenePreviewAttestationSchema.shape.source,
    effectiveFrom: z.literal('next_load'),
  }).strict();
export const PersonalSceneConfirmResponseSchema = z
  .object({ receipt: PersonalSceneConfirmReceiptSchema })
  .strict();
export type PersonalScenePreviewAttestation = z.infer<
  typeof PersonalScenePreviewAttestationSchema
>;
export type PersonalScenePreviewRequest = z.infer<
  typeof PersonalScenePreviewRequestSchema
>;
export type PersonalScenePreviewResponse = z.infer<
  typeof PersonalScenePreviewResponseSchema
>;
export type PersonalSceneConfirmRequest = z.infer<
  typeof PersonalSceneConfirmRequestSchema
>;
export type PersonalSceneConfirmReceipt = z.infer<
  typeof PersonalSceneConfirmReceiptSchema
>;
export type PersonalSceneConfirmResponse = z.infer<
  typeof PersonalSceneConfirmResponseSchema
>;

export const PersonalSceneRemoveRequestSchema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    expectedContentRef: PersonalSceneContentRefSchema,
  })
  .strict();
export const PersonalSceneRemoveReceiptSchema = z
  .object({
    operation: z.literal('remove'),
    scope: z.literal('scene_all_history'),
    instanceId: UuidSchema,
    sceneId: UuidSchema,
    requestId: UuidSchema,
    revision: z.number().int().positive(),
    removed: z.literal(true),
  })
  .strict();
export const PersonalSceneRemoveResponseSchema = z
  .object({
    receipt: PersonalSceneRemoveReceiptSchema,
  })
  .strict();
export type PersonalSceneRemoveRequest = z.infer<
  typeof PersonalSceneRemoveRequestSchema
>;
export type PersonalSceneRemoveReceipt = z.infer<
  typeof PersonalSceneRemoveReceiptSchema
>;
export type PersonalSceneRemoveResponse = z.infer<
  typeof PersonalSceneRemoveResponseSchema
>;
