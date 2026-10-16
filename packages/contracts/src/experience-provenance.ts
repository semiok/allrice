import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { ExperienceReadPinSchema } from './experience-adoption.ts';
import { PersonalSkillPinSchema } from './personal-skills.ts';

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Rebuildable view of a validated rule; never an independent authority. */
export const ExperienceProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    algorithm: z.literal('validated-rule-v1'),
    pin: ExperienceReadPinSchema,
    topic: z.enum(['attendance', 'report_style']),
    rule: z.string().min(1).max(4000),
    applicability: z.string().min(1).max(600),
    occurrenceId: UuidSchema,
    draftIndex: z.number().int().min(0).max(7),
    sourceIds: z.array(UuidSchema).min(1).max(16),
    sourceDigest: Digest,
    outputDigest: Digest,
  })
  .strict();
export type ExperienceProjection = z.infer<typeof ExperienceProjectionSchema>;

export const ExperienceProvenanceSchema = z
  .object({
    workspaceId: UuidSchema,
    projection: ExperienceProjectionSchema,
    representation: z.enum(['projection', 'original']),
    indexState: z.enum(['current', 'missing', 'outdated']),
    adoptedAt: TimestampSchema,
    consolidationRunId: UuidSchema,
    sources: z
      .array(
        z
          .object({
            id: UuidSchema,
            runId: UuidSchema,
            sessionId: UuidSchema,
            messageId: UuidSchema,
            excerpt: z.string().min(1).max(4000),
            sourceDigest: Digest,
            skills: z.array(PersonalSkillPinSchema).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.sources.reduce((n, source) => n + source.excerpt.length, 0) > 32000
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Experience sources exceed the bounded input.',
      });
    const ids = value.sources.map((source) => source.id);
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== value.projection.sourceIds.length ||
      value.projection.sourceIds.some((id) => !ids.includes(id))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Experience sources do not match the adopted draft.',
      });
  });
export type ExperienceProvenance = z.infer<typeof ExperienceProvenanceSchema>;
