import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { PersonalSkillPinSchema } from './personal-skills.ts';
import {
  EmployeeSceneReadSchema,
  employeeContentLimits,
} from './employee-content.ts';
import { PersonalSceneUseSchema } from './employee-scene-skills.ts';

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Explicit organization configuration; no legacy policy/default adoption. */
export const MemorySourceCollectionPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    enabled: z.boolean(),
    revision: z.number().int().positive(),
    collectionStartedAt: TimestampSchema,
  })
  .strict();
export type MemorySourceCollectionPolicy = z.infer<
  typeof MemorySourceCollectionPolicySchema
>;

/** Raw, unconfirmed human provenance kept outside personal memory entries. */
export const MemorySourceEvidenceSchema = z
  .object({
    schemaVersion: z.literal(2),
    policyRevision: z.number().int().positive(),
    collectionStartedAt: TimestampSchema,
    capturedAt: TimestampSchema,
    kind: z.enum(['human_message', 'adopted_steering']),
    captureRunId: UuidSchema,
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
    scenes: z
      .array(
        z
          .object({
            runId: UuidSchema,
            receipt: EmployeeSceneReadSchema.extend({
              personal: EmployeeSceneReadSchema.shape.personal.unwrap(),
            }),
            uses: z
              .array(
                z
                  .object({ eventId: UuidSchema, use: PersonalSceneUseSchema })
                  .strict(),
              )
              .max(64),
          })
          .strict(),
      )
      .max(employeeContentLimits.scenes),

    truncated: z.boolean(),
  })
  .strict();
export type MemorySourceEvidence = z.infer<typeof MemorySourceEvidenceSchema>;
