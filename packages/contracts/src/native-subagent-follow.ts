import { z } from 'zod';
import { NativeSubagentSummarySchema } from './native-subagent-summary.ts';
import { NativeSubagentSnapshotSchema } from './native-subagent-snapshot.ts';

export const NativeSubagentFollowEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('directory'),
    summary: NativeSubagentSummarySchema,
  }),
  z.object({
    type: z.literal('snapshot'),
    snapshot: NativeSubagentSnapshotSchema,
  }),
  z.object({
    type: z.literal('display'),
    rootId: z.string(),
    childId: z.string(),
    hostEpoch: z.number().int().nonnegative(),
    display: NativeSubagentSnapshotSchema.shape.stream,
  }),
  z.object({
    type: z.literal('summary'),
    childId: z.string(),
    summary: NativeSubagentSummarySchema.nullable(),
  }),
  z.object({
    type: z.literal('clear'),
    reason: z.enum(['resync', 'unavailable']),
  }),
]);
export type NativeSubagentFollowEvent = z.infer<
  typeof NativeSubagentFollowEventSchema
>;
