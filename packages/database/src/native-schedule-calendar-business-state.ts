import { z } from 'zod';
import { UuidSchema } from '@allrice/contracts';
import { nativeOnceDigest } from './native-schedule-once-state.ts';

const Revision = z.number().int().positive().safe();
const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Instant = z
  .string()
  .refine(
    (s) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s,
  );

/** An accepted business P, not authority to call native create. In particular a
 * Web policy transaction can persist this without learning a writer token. */
export const NativeCalendarPlanSchema = z
  .object({
    periodId: UuidSchema,
    controlId: UuidSchema,
    automationId: UuidSchema,
    revision: Revision,
    businessScheduledFor: Instant,
    initialArmId: UuidSchema,
    revisionDigest: Digest,
    createdAt: Instant,
    cause: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('handoff') }).strict(),
      z.object({ kind: z.literal('request'), requestId: UuidSchema }).strict(),
      z
        .object({ kind: z.literal('operation'), operationId: UuidSchema })
        .strict(),
      z
        .object({ kind: z.literal('policy'), policyRevision: Revision })
        .strict(),
      z
        .object({
          kind: z.literal('successor'),
          predecessorPeriodId: UuidSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('coalesced'),
          predecessorPeriodId: UuidSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export type NativeCalendarPlan = z.infer<typeof NativeCalendarPlanSchema>;

const Lease = z
  .object({
    ownerId: UuidSchema,
    epoch: Revision,
    tokenDigest: Digest,
  })
  .strict();
const Budget = z
  .object({
    globalCount: z.number().int().nonnegative().safe(),
    organizationCount: z.number().int().nonnegative().safe(),
    instanceCount: z.number().int().nonnegative().safe(),
  })
  .strict();

/** Native phase/version are deliberately absent. Business progress must not
 * invalidate a retained Task journal or change its exact acknowledgement. */
export const NativeCalendarDecisionSchema = z
  .object({
    decisionId: UuidSchema,
    periodId: UuidSchema,
    kind: z.enum(['receipt', 'policy', 'authority', 'operation']),
    outcome: z.enum([
      'queued',
      'empty',
      'budget',
      'already_claimed',
      'coalesced',
      'canceled',
      'authority_blocked',
    ]),
    decidedAt: Instant,
    revision: Revision,
    receiptOccurrenceId: UuidSchema.nullable(),
    automationRunId: UuidSchema.nullable(),
    successorPeriodId: UuidSchema.nullable(),
    lease: Lease.nullable(),
    budget: Budget.nullable(),
    operationId: UuidSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const receipt = v.kind === 'receipt';
    const advances = [
      'queued',
      'empty',
      'budget',
      'already_claimed',
      'coalesced',
    ].includes(v.outcome);
    const hasRun = ['queued', 'empty', 'already_claimed'].includes(v.outcome);
    if (
      receipt !== (v.receiptOccurrenceId !== null) ||
      receipt !== (v.lease !== null) ||
      advances !== (v.successorPeriodId !== null) ||
      hasRun !== (v.automationRunId !== null) ||
      (v.outcome === 'budget') !== (v.budget !== null) ||
      (advances && !receipt) ||
      (receipt && v.outcome === 'canceled') ||
      (v.kind === 'policy' && v.outcome !== 'canceled') ||
      (v.kind === 'operation' && v.outcome !== 'canceled') ||
      (v.kind === 'operation') !== (v.operationId !== undefined) ||
      (v.kind === 'authority' && v.outcome !== 'authority_blocked') ||
      v.successorPeriodId === v.periodId
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid calendar business decision',
      });
  });
export type NativeCalendarDecision = z.infer<
  typeof NativeCalendarDecisionSchema
>;

export function calendarPlanDigest(value: NativeCalendarPlan) {
  return nativeOnceDigest(NativeCalendarPlanSchema.parse(value));
}
export function calendarDecisionDigest(value: NativeCalendarDecision) {
  return nativeOnceDigest(NativeCalendarDecisionSchema.parse(value));
}
