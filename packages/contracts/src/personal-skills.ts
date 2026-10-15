import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';

/** Private additions never participate in platform review or capability grants. */
export const personalSkillLimits = {
  sourceBytes: 256 * 1024,
  installations: 32,
  retainedInstallations: 128,
  enabledPerInstance: 8,
} as const;

export const PersonalSkillDefinitionSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    description: z.string().trim().min(1).max(500),
    content: z.string().min(1).max(personalSkillLimits.sourceBytes),
    checksum: ChecksumSchema,
    invocation: z
      .object({ modelInvocable: z.boolean(), userInvocable: z.boolean() })
      .strict(),
    whenToUse: z.string().max(2_000).optional(),
    metadata: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export type PersonalSkillDefinition = z.infer<
  typeof PersonalSkillDefinitionSchema
>;

export const PersonalSkillSourceSchema = z
  .object({
    kind: z.literal('attachment'),
    objectId: UuidSchema,
    fileName: z.string().min(1).max(255),
    originalChecksum: ChecksumSchema,
    byteLength: z
      .number()
      .int()
      .positive()
      .max(personalSkillLimits.sourceBytes),
  })
  .strict();

export const PersonalSkillPinSchema = z
  .object({
    organizationId: UuidSchema,
    ownerId: UuidSchema,
    instanceId: UuidSchema,
    installationId: UuidSchema,
    versionId: UuidSchema,
    bindingId: UuidSchema,
    // Changes on revoke/re-enable, not on an ordinary version update. A revoked
    // historical Run must not regain access after a later explicit re-enable.
    bindingEpoch: z.number().int().positive(),
    definitionChecksum: ChecksumSchema,
  })
  .strict();
export type PersonalSkillPin = z.infer<typeof PersonalSkillPinSchema>;

export const PersonalSkillSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: UuidSchema,
    skills: z
      .array(PersonalSkillPinSchema)
      .max(personalSkillLimits.enabledPerInstance),
    checksum: ChecksumSchema,
  })
  .strict();
export type PersonalSkillSnapshot = z.infer<typeof PersonalSkillSnapshotSchema>;

export const PersonalSkillInstallInputSchema = z
  .object({ objectId: UuidSchema })
  .strict();
export const PersonalSkillManageInputSchema = z
  .object({
    installationId: UuidSchema,
    expectedRevision: z.number().int().positive(),
    operation: z.enum(['enable', 'disable', 'uninstall']),
  })
  .strict();
export const PersonalSkillManageRequestSchema =
  PersonalSkillManageInputSchema.extend({
    workspaceId: UuidSchema,
    instanceId: UuidSchema.optional(),
    requestId: UuidSchema,
  })
    .strict()
    .refine((value) => value.operation === 'uninstall' || !!value.instanceId, {
      message: 'An instance is required to enable or disable a binding',
      path: ['instanceId'],
    });

export const PersonalSkillItemSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    description: z.string(),
    revision: z.number().int().positive(),
    state: z.enum(['installed', 'uninstalled']),
    versionId: UuidSchema,
    version: z.number().int().positive(),
    source: PersonalSkillSourceSchema,
    definitionChecksum: ChecksumSchema,
    compatibility: z.literal('instruction_format_checked'),
    // A successful load does not prove a business task passed.
    businessVerification: z.literal('not_verified'),
    bindings: z.array(
      z
        .object({
          id: UuidSchema,
          instanceId: UuidSchema,
          workspaceId: UuidSchema,
          enabled: z.boolean(),
          epoch: z.number().int().positive(),
          label: z.string().min(1).max(240),
        })
        .strict(),
    ),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type PersonalSkillItem = z.infer<typeof PersonalSkillItemSchema>;
