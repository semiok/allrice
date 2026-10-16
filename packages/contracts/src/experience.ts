import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { MemoryClassSchema } from './operations.ts';
import { PersonalSkillPinSchema } from './personal-skills.ts';
import { ExperienceAdoptionViewSchema } from './experience-adoption.ts';
import { ExperienceValidationViewSchema } from './experience-validation.ts';

/** Platform Skills keep their separate source/license/test/publication gate. */
export const ExperienceScopeSchema = z.enum([
  'private',
  'workspace',
  'platform',
]);
export const ExperienceStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
]);
const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const LegacyExperienceCollectionPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    frequency: z.enum(['off', 'daily', 'weekly', 'monthly']),
    collectionStartedAt: TimestampSchema,
    authorizationSource: z.literal('platform_automatic_experience_policy'),
  })
  .strict();
export const ExperiencePolicySettingsSchema = z
  .object({
    frequency: z.enum(['off', 'daily', 'weekly', 'monthly']),
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Choose an IANA timezone'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    weekday: z.number().int().min(0).max(6),
    monthDay: z.number().int().min(1).max(31),
  })
  .strict();
export const ExperienceCollectionPolicySchema = z.discriminatedUnion(
  'schemaVersion',
  [
    LegacyExperienceCollectionPolicySchema,
    LegacyExperienceCollectionPolicySchema.extend({
      schemaVersion: z.literal(2),
      ...ExperiencePolicySettingsSchema.shape,
    }).strict(),
    LegacyExperienceCollectionPolicySchema.extend({
      schemaVersion: z.literal(3),
      ...ExperiencePolicySettingsSchema.shape,
      validationMode: z.enum(['off', 'supported_cases']),
    }).strict(),
    LegacyExperienceCollectionPolicySchema.extend({
      schemaVersion: z.literal(4),
      ...ExperiencePolicySettingsSchema.shape,
      validationMode: z.enum(['off', 'supported_cases']),
      adoptionMode: z.enum(['off', 'supported_private']),
      adoptionAuthorizedBy: UuidSchema.nullable(),
    })
      .strict()
      .refine(
        (p) => p.adoptionMode === 'off' || p.adoptionAuthorizedBy !== null,
      ),
  ],
);
export function experiencePolicySchedule(
  policy: z.infer<typeof ExperienceCollectionPolicySchema>,
) {
  return policy.schemaVersion !== 1
    ? {
        frequency: policy.frequency,
        timezone: policy.timezone,
        time: policy.time,
        weekday: policy.weekday,
        monthDay: policy.monthDay,
      }
    : {
        frequency: policy.frequency,
        timezone: 'Asia/Shanghai',
        time: '03:00',
        weekday: 1,
        monthDay: 1,
      };
}
/** Operational metadata only. Safe for an explicitly authorized administrator;
 * private rules, source excerpts and Skill pins belong to the owner response. */
export const ExperienceSummarySchema = z
  .object({
    enabled: z.boolean(),
    policy: ExperiencePolicySettingsSchema.extend({
      source: z.enum(['platform', 'company']),
      revision: z.number().int().positive(),
      validationMode: z.enum(['off', 'supported_cases']),
      adoptionMode: z.enum(['off', 'supported_private']),
    }).strict(),
    schedule: z
      .object({
        state: z.enum([
          'off',
          'not_scheduled',
          'scheduled',
          'paused',
          'unavailable',
        ]),
        lastCheckedAt: TimestampSchema.nullable(),
        nextRunAt: TimestampSchema.nullable(),
        lastOccurrence: z
          .object({
            createdAt: TimestampSchema,
            outcome: z.enum([
              'queued',
              'running',
              'failed',
              'canceled',
              'no_sources',
              'no_draft',
              'drafted',
            ]),
          })
          .strict()
          .nullable(),
      })
      .strict(),
    counts: z
      .object({
        pendingSources: z.number().int().nonnegative(),
        awaitingValidation: z.number().int().nonnegative(),
        adoptedTotal: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ExperienceSummary = z.infer<typeof ExperienceSummarySchema>;
export const ExperienceOverviewSchema = z
  .object({
    visibility: z.literal('owner'),
    workspaceId: UuidSchema,
    instanceId: UuidSchema,
    summary: ExperienceSummarySchema,
  })
  .strict();
export type ExperienceOverview = z.infer<typeof ExperienceOverviewSchema>;
export const ExperienceDraftOutputSchema = z
  .object({
    schemaVersion: z.literal(1),
    drafts: z
      .array(
        z
          .object({
            sourceIds: z.array(UuidSchema).min(1).max(16),
            rule: z.string().trim().min(1).max(4000),
            reason: z.string().trim().min(1).max(800),
            applicability: z.string().trim().min(1).max(600),
            confidence: z.enum(['tentative', 'consistent']),
            validation: z
              .object({
                kind: z.enum(['preference', 'workflow', 'calculation']),
                check: z.string().trim().min(1).max(600),
              })
              .strict(),
          })
          .strict(),
      )
      .max(8),
    discarded: z
      .array(
        z
          .object({
            sourceIds: z.array(UuidSchema).min(1).max(16),
            reason: z.string().trim().min(1).max(800),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type ExperienceDraftOutput = z.infer<typeof ExperienceDraftOutputSchema>;
export const ExperienceDraftBatchSchema = z
  .object({
    id: UuidSchema,
    runId: UuidSchema.nullable(),
    instanceId: UuidSchema,
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    state: z.enum(['pending_validation', 'not_ready']),
    revision: z.literal(1).nullable(),
    digest: DigestSchema.nullable(),
    createdAt: TimestampSchema,
    errorCode: z.string().nullable(),
    sourceIds: z.array(UuidSchema).max(16),
    drafts: ExperienceDraftOutputSchema.shape.drafts,
    adoptions: z.array(ExperienceAdoptionViewSchema).max(8).default([]),
    validations: z.array(ExperienceValidationViewSchema).max(8).default([]),
    validationNotes: z.array(z.string().max(500)).max(8).default([]),
    sourceState: z.enum(['current', 'unavailable']).optional(),
    skillDependencies: z.array(PersonalSkillPinSchema).max(256).optional(),
  })
  .strict();
export type ExperienceDraftBatch = z.infer<typeof ExperienceDraftBatchSchema>;
/** Every input is accounted for exactly once. Model text cannot invent provenance. */
export function validateExperienceDraftOutput(
  raw: unknown,
  sourceIds: readonly string[],
) {
  const output = ExperienceDraftOutputSchema.parse(raw);
  const consumed = [...output.drafts, ...output.discarded].flatMap(
    (d) => d.sourceIds,
  );
  if (
    new Set(sourceIds).size !== sourceIds.length ||
    consumed.length !== sourceIds.length ||
    new Set(consumed).size !== consumed.length ||
    consumed.some((id) => !sourceIds.includes(id))
  )
    throw Error('EXPERIENCE_DRAFT_SOURCE_MISMATCH');
  return output;
}
export const ExperienceEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyRevision: z.number().int().positive(),
    collectionStartedAt: TimestampSchema,
    capturedAt: TimestampSchema,
    kind: z.enum(['correction', 'explicit_feedback']),
    messageId: UuidSchema,
    runId: UuidSchema,
    relatedRunId: UuidSchema.nullable(),
    // Captured identity, not a claim that an installed/registered skill ran.
    skills: z
      .array(
        z
          .object({
            runId: UuidSchema,
            eventId: UuidSchema,
            pin: PersonalSkillPinSchema,
          })
          .strict(),
      )
      .max(16),
    artifacts: z
      .array(
        z
          .object({
            runId: UuidSchema,
            versionId: UuidSchema,
            objectId: UuidSchema,
            checksum: DigestSchema,
          })
          .strict(),
      )
      .max(32),
    inputs: z
      .array(
        z
          .object({
            messageId: UuidSchema,
            objectId: UuidSchema,
            checksum: DigestSchema,
          })
          .strict(),
      )
      .max(32),
    // Available frozen context is deliberately distinct from actual tool reads.
    availableKnowledge: z
      .array(
        z
          .object({
            runId: UuidSchema,
            revisionId: UuidSchema,
            checksum: DigestSchema,
          })
          .strict(),
      )
      .max(64),
    truncated: z.boolean(),
  })
  .strict();
export type ExperienceEvidence = z.infer<typeof ExperienceEvidenceSchema>;
export const CreateExperienceInputSchema = z
  .object({
    clientRequestId: UuidSchema,
    runId: UuidSchema,
    messageId: UuidSchema,
    sourceExcerpt: z.string().trim().min(1).max(4000),
    content: z.string().trim().min(1).max(4000),
    memoryClass: MemoryClassSchema,
    scope: ExperienceScopeSchema,
    shareAcknowledged: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope !== 'private' && !value.shareAcknowledged)
      ctx.addIssue({
        code: 'custom',
        path: ['shareAcknowledged'],
        message:
          'Sharing the exact rewritten rule requires explicit owner consent',
      });
  });
export const ReviewExperienceInputSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    expectedRevision: z.number().int().positive(),
    expectedDigest: DigestSchema,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const ExperienceCandidateSchema = z
  .object({
    id: UuidSchema,
    content: z.string().max(4000),
    memoryClass: MemoryClassSchema,
    scope: ExperienceScopeSchema,
    status: ExperienceStatusSchema,
    archived: z.boolean(),
    revision: z.number().int().positive(),
    digest: DigestSchema,
    source: z
      .object({
        runId: UuidSchema,
        sessionId: UuidSchema,
        messageId: UuidSchema,
        excerpt: z.string().max(4000),
        digest: DigestSchema,
      })
      .strict()
      .nullable(),
    ownedByMe: z.boolean(),
    canReview: z.boolean(),
    createdAt: TimestampSchema,
    reviewedAt: TimestampSchema.nullable(),
    reviewReason: z.string().max(500).nullable(),
    originKind: z.enum(['manual', 'incremental', 'derived']).optional(),
    instanceId: UuidSchema.nullable().optional(),
    evidence: ExperienceEvidenceSchema.nullable().optional(),
    consolidatedAt: TimestampSchema.nullable().optional(),
  })
  .strict();
export type ExperienceCandidate = z.infer<typeof ExperienceCandidateSchema>;
export type CreateExperienceInput = z.infer<typeof CreateExperienceInputSchema>;
