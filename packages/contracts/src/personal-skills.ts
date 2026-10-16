import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ChecksumSchema } from './runs.ts';
import { SkillResourcePathSchema } from './skill-bundle.ts';

/** Private additions never participate in platform review or capability grants. */
export const personalSkillLimits = {
  sourceBytes: 256 * 1024,
  archiveBytes: 8_000_000,
  packageCandidates: 8,
  packageResources: 32,
  resourceBytes: 131_072,
  totalResourceBytes: 524_288,
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
      .max(personalSkillLimits.archiveBytes),
    // Omitted for the original standalone SKILL.md format.
    candidatePath: z.string().min(1).max(512).optional(),
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
    packageChecksum: ChecksumSchema.optional(),
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

export const PersonalSkillInstallInputSchema = z.union([
  z.object({ objectId: UuidSchema }).strict(),
  z
    .object({ importId: UuidSchema, candidatePath: z.string().min(1).max(512) })
    .strict(),
  z.object({ importId: UuidSchema, operation: z.literal('cancel') }).strict(),
]);

export const PersonalSkillResourceSchema = z
  .object({
    path: SkillResourcePathSchema,
    mediaType: z
      .string()
      .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)
      .max(120),
    byteLength: z.number().int().min(0).max(personalSkillLimits.resourceBytes),
    checksum: ChecksumSchema,
  })
  .strict();
export const PersonalSkillPackageSchema = z
  .object({
    schemaVersion: z.literal(1),
    archiveObjectId: UuidSchema,
    sourcePath: z.string().min(1).max(512),
    resources: z
      .array(PersonalSkillResourceSchema)
      .max(personalSkillLimits.packageResources),
    checksum: ChecksumSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.resources.reduce((sum, resource) => sum + resource.byteLength, 0) >
      personalSkillLimits.totalResourceBytes
    )
      ctx.addIssue({
        code: 'custom',
        message: 'personal_skill_resources_too_large',
      });
    const paths = value.resources.map((resource) =>
      resource.path.toLowerCase(),
    );
    if (new Set(paths).size !== paths.length)
      ctx.addIssue({
        code: 'custom',
        message: 'personal_skill_resource_path_conflict',
      });
  });
export type PersonalSkillPackage = z.infer<typeof PersonalSkillPackageSchema>;

export const PersonalSkillCandidateSchema = z
  .object({
    sourcePath: z.string().min(1).max(512),
    originalText: z.string().max(personalSkillLimits.sourceBytes).optional(),
    definition: PersonalSkillDefinitionSchema.optional(),
    resources: z
      .array(PersonalSkillResourceSchema)
      .max(personalSkillLimits.packageResources),
    issues: z
      .array(
        z
          .object({
            code: z.string().min(1).max(80),
            path: z.string().max(512),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();
export type PersonalSkillCandidate = z.infer<
  typeof PersonalSkillCandidateSchema
>;
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
    packageChecksum: ChecksumSchema.optional(),
    resourceCount: z
      .number()
      .int()
      .min(0)
      .max(personalSkillLimits.packageResources)
      .optional(),
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
