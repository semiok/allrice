import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import {
  PersonalSkillDefinitionSchema,
  PersonalSkillGitHubSourceSchema,
  PersonalSkillGitHubUrlSchema,
  PersonalSkillItemSchema,
  PersonalSkillSourceSchema,
  PersonalSkillVersionPreviewSchema,
  personalSkillLimits,
} from './personal-skills.ts';

export const PersonalSkillPreviewTargetSchema = z.discriminatedUnion(
  'operation',
  [
    z.object({ operation: z.literal('install') }).strict(),
    z
      .object({
        operation: z.literal('update'),
        installationId: UuidSchema,
        expectedRevision: z.number().int().positive(),
        expectedVersionId: UuidSchema,
      })
      .strict(),
  ],
);

export const PersonalSkillPreviewAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    instanceId: UuidSchema,
    source: z.union([
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
    ]),
    sourcePath: z.literal('SKILL.md'),
    digest: ChecksumSchema,
    target: z.discriminatedUnion('operation', [
      PersonalSkillPreviewTargetSchema.options[0].extend({
        expectedInstallation: z
          .object({
            id: UuidSchema,
            revision: z.number().int().positive(),
            versionId: UuidSchema,
          })
          .strict()
          .nullable(),
      }),
      PersonalSkillPreviewTargetSchema.options[1].extend({
        bindingsDigest: ChecksumSchema,
      }),
    ]),
    expiresAt: TimestampSchema,
  })
  .strict();
export type PersonalSkillPreviewAttestation = z.infer<
  typeof PersonalSkillPreviewAttestationSchema
>;

/** Browser-safe contracts: signing and archive decoding remain server-only. */
export const PersonalSkillAffectedBindingsSchema =
  PersonalSkillVersionPreviewSchema.shape.bindings;
export const PersonalSkillPreviewRequestSchema = z
  .object({
    workspaceId: UuidSchema,
    target: PersonalSkillPreviewTargetSchema,
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('github'),
          url: PersonalSkillGitHubUrlSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('zip'),
          fileName: z.string().min(1).max(255),
        })
        .strict(),
    ]),
  })
  .strict();
export const PersonalSkillConfirmRequestSchema = z
  .object({
    workspaceId: UuidSchema,
    requestId: UuidSchema,
    previewId: z.string().min(1),
    digest: ChecksumSchema,
  })
  .strict();
export const PersonalSkillPreviewResponseSchema = z
  .object({
    instanceId: UuidSchema,
    operation: z.enum(['install', 'update']),
    previewId: z.string().min(1),
    digest: ChecksumSchema,
    expiresAt: TimestampSchema,
    target: PersonalSkillPreviewAttestationSchema.shape.target,
    affectedBindings: PersonalSkillAffectedBindingsSchema.optional(),
    item: PersonalSkillDefinitionSchema.pick({
      name: true,
      description: true,
      whenToUse: true,
      invocation: true,
    }).extend({
      displayName: z.string().optional(),
      version: z.string().optional(),
    }),
    source: PersonalSkillPreviewAttestationSchema.shape.source,
    files: z.array(
      z
        .object({
          path: z.string(),
          byteLength: z.number().int().nonnegative(),
          checksum: ChecksumSchema,
        })
        .strict(),
    ),
    effectiveFrom: z.literal('next_task'),
    installed: z.literal(false),
    scriptsExecuted: z.literal(false),
  })
  .strict();
export const PersonalSkillConfirmReceiptSchema = z
  .object({
    operation: z.enum(['install', 'update']),
    requestId: UuidSchema,
    instanceId: UuidSchema,
    installationId: UuidSchema,
    revision: z.number().int().positive(),
    versionId: UuidSchema,
    definitionChecksum: ChecksumSchema,
    packageChecksum: ChecksumSchema.optional(),
    source: PersonalSkillSourceSchema,
    effectiveFrom: z.literal('next_task'),
    affectedBindings: PersonalSkillAffectedBindingsSchema.optional(),
    unchanged: z.boolean().optional(),
  })
  .strict();
export const PersonalSkillConfirmResponseSchema = z
  .object({
    skill: PersonalSkillItemSchema,
    affectedBindings: PersonalSkillAffectedBindingsSchema.optional(),
    receipt: PersonalSkillConfirmReceiptSchema,
  })
  .strict();
export type PersonalSkillPreviewRequest = z.infer<
  typeof PersonalSkillPreviewRequestSchema
>;
export type PersonalSkillPreviewResponse = z.infer<
  typeof PersonalSkillPreviewResponseSchema
>;
export type PersonalSkillConfirmRequest = z.infer<
  typeof PersonalSkillConfirmRequestSchema
>;
export type PersonalSkillConfirmResponse = z.infer<
  typeof PersonalSkillConfirmResponseSchema
>;
export type PersonalSkillConfirmReceipt = z.infer<
  typeof PersonalSkillConfirmReceiptSchema
>;
export type PersonalSkillAffectedBindings = z.infer<
  typeof PersonalSkillAffectedBindingsSchema
>;
