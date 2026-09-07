import { z } from 'zod';

import { TimestampSchema, UuidSchema } from '../common.ts';
import {
  RuntimeAttemptRefSchema,
  RuntimeContractVersionSchema,
  RuntimeTaskRefSchema,
} from './identity.ts';

export const RuntimeUsageSourceSchema = z
  .object({
    kind: z.enum([
      'provider',
      'harness',
      'worker',
      'bridge',
      'cloud_runner',
      'estimator',
    ]),
    sourceId: z.string().trim().min(1).max(240),
  })
  .strict();

export const RuntimeUsageBoundarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('root_run'), runId: UuidSchema }).strict(),
  z.object({ kind: z.literal('run'), runId: UuidSchema }).strict(),
  z
    .object({
      kind: z.literal('operation'),
      attempt: RuntimeAttemptRefSchema,
    })
    .strict(),
]);

export const RuntimeUsageMetricSchema = z.enum([
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'model_calls',
  'tool_calls',
  'wall_time',
  'output_bytes',
  'cost',
]);

export const RuntimeUsageUnitSchema = z.enum([
  'tokens',
  'calls',
  'milliseconds',
  'bytes',
  'currency_microunits',
]);

const metricUnits: Record<
  z.infer<typeof RuntimeUsageMetricSchema>,
  z.infer<typeof RuntimeUsageUnitSchema>
> = {
  input_tokens: 'tokens',
  cached_input_tokens: 'tokens',
  output_tokens: 'tokens',
  model_calls: 'calls',
  tool_calls: 'calls',
  wall_time: 'milliseconds',
  output_bytes: 'bytes',
  cost: 'currency_microunits',
};

/**
 * A typed observation, NOT a bill, budget reservation or aggregation engine.
 *
 * observationId identifies one immutable report; accountingId identifies the
 * same metered item across its reserved/spent/settled reports. Neither permits
 * a consumer to sum lifecycle states or repeated cumulative snapshots.
 *
 * A cumulative meter reset starts a new window.id. includes_descendants is an
 * explicit overlapping aggregate: do not add it to those descendants again.
 * self_only excludes separately accounted child Runs/operations, not OS
 * subprocesses already covered by the source meter. cached_input_tokens is a
 * subset of input_tokens, not an additional input total.
 *
 * Source authentication, persisted deduplication, authoritative meter choice,
 * temporal ordering, reconciliation and root-budget enforcement belong to the
 * subsequent ledger/adapter implementation. Parsing alone proves none of them.
 */
export const RuntimeUsageObservationSchema = z
  .object({
    contractVersion: RuntimeContractVersionSchema,
    observationId: UuidSchema,
    accountingId: UuidSchema,
    task: RuntimeTaskRefSchema,
    source: RuntimeUsageSourceSchema,
    accountingBoundary: RuntimeUsageBoundarySchema,
    aggregation: z.enum(['self_only', 'includes_descendants']),
    metric: RuntimeUsageMetricSchema,
    unit: RuntimeUsageUnitSchema,
    // A cost amount is integer millionths of the named currency's major unit.
    // No FX conversion or rounding is performed by this contract.
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    mode: z.enum(['delta', 'cumulative']),
    quality: z.enum(['measured', 'estimated', 'unknown']),
    amount: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    state: z.enum(['reserved', 'spent', 'settled']),
    window: z
      .object({
        id: UuidSchema,
        startedAt: TimestampSchema,
        endedAt: TimestampSchema,
      })
      .strict(),
    observedAt: TimestampSchema,
  })
  .strict()
  .superRefine((observation, ctx) => {
    if ((observation.quality === 'unknown') !== (observation.amount === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message:
          'unknown usage requires null; measured or estimated usage requires an amount',
      });
    }
    if (metricUnits[observation.metric] !== observation.unit) {
      ctx.addIssue({
        code: 'custom',
        path: ['unit'],
        message: 'usage unit must match its metric',
      });
    }
    if ((observation.metric === 'cost') !== (observation.currency !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'only cost observations require a currency',
      });
    }

    const boundary = observation.accountingBoundary;
    if (
      (boundary.kind === 'root_run' &&
        boundary.runId !== observation.task.rootRunId) ||
      (boundary.kind === 'run' && boundary.runId !== observation.task.runId)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['accountingBoundary'],
        message: 'usage boundary must match its task reference',
      });
    }
    if (
      boundary.kind === 'operation' &&
      observation.aggregation !== 'self_only'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['aggregation'],
        message:
          'operation observations cannot aggregate child Run/operation accounting',
      });
    }
    if (
      Date.parse(observation.window.endedAt) <
      Date.parse(observation.window.startedAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['window', 'endedAt'],
        message: 'usage window end cannot precede its start',
      });
    }
    if (
      Date.parse(observation.observedAt) <
      Date.parse(observation.window.endedAt)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['observedAt'],
        message: 'usage cannot be observed before the measurement window ends',
      });
    }
  });

export type RuntimeUsageObservation = z.infer<
  typeof RuntimeUsageObservationSchema
>;
