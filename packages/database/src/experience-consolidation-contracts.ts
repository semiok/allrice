import { z } from 'zod';
import {
  UuidSchema,
  TimestampSchema,
  ExperienceCollectionPolicySchema,
  ExperienceEvidenceSchema,
  ExperienceModelSnapshotSchema,
  DshNativeSkillSnapshotSchema,
  EmployeeBaseSkillCatalogSchema,
  ExperienceDraftOutputSchema,
  EmployeeRuntimeContentSchema,
  EmployeeInstanceProfileSchema,
  EmployeeResolvedContentSchema,
} from '@allrice/contracts';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const experienceConsolidationJobType = 'allrice.experience.consolidate';
export const experienceConsolidationLimits = {
  sources: 16,
  sourceCharacters: 32000,
  timeoutMs: 300000,
  organizationDailyRuns: 8,
  globalDailyRuns: 64,
} as const;
export const ExperienceAutomationBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    instanceId: UuidSchema,
    policyDigest: digest,
  })
  .strict();
export const ExperienceOccurrenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    assignmentId: UuidSchema,
    instanceId: UuidSchema,
    employeeId: UuidSchema,
    employeeVersionId: UuidSchema,
    instanceDigest: digest,
    currentRules: z
      .object({
        profile: EmployeeInstanceProfileSchema,
        index: EmployeeRuntimeContentSchema,
        platformRequirements: z.array(z.string()),
        sources: z.array(
          EmployeeResolvedContentSchema.pick({
            reference: true,
            available: true,
            title: true,
            body: true,
          }),
        ),
      })
      .strict(),
    policy: ExperienceCollectionPolicySchema,
    policyDigest: digest,
    createdAt: TimestampSchema,
    sources: z
      .array(
        z
          .object({
            id: UuidSchema,
            runId: UuidSchema,
            sessionId: UuidSchema,
            messageId: UuidSchema,
            excerpt: z.string().min(1).max(4000),
            sourceDigest: digest,
            evidence: ExperienceEvidenceSchema,
          })
          .strict(),
      )
      .max(experienceConsolidationLimits.sources),
  })
  .strict();
export type ExperienceOccurrence = z.infer<typeof ExperienceOccurrenceSchema>;
export const ExperienceExecutionSchema = z
  .object({
    schemaVersion: z.literal(1),
    occurrenceDigest: digest,
    model: ExperienceModelSnapshotSchema,
    nativeSkills: z.array(DshNativeSkillSnapshotSchema).length(1),
    catalog: EmployeeBaseSkillCatalogSchema,
  })
  .strict();
export type ExperienceExecution = z.infer<typeof ExperienceExecutionSchema>;
export const ExperienceReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.literal('pending_validation'),
    occurrenceDigest: digest,
    executionDigest: digest,
    runId: UuidSchema,
    output: ExperienceDraftOutputSchema,
    revision: z.literal(1),
    outputDigest: digest,
    skillLoadEventId: UuidSchema,
    createdAt: TimestampSchema,
  })
  .strict();
