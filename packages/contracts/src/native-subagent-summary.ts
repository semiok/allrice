import { z } from 'zod';
import { nativeChildViewLimits } from './native-subagent-snapshot.ts';

// Each cut belongs to one Session, never an atomic tree or durable-end proof.
const observation = z.object({
  source: z.enum(['live', 'prepared']),
  cursor: z.number().int().min(-1),
});
const address = z.object({
  id: z.string(),
  parentId: z.string(),
  depth: z.number().int().positive(),
});
export const NativeSubagentSummarySchema = z.object({
  rootId: z.string(),
  root: observation,
  descendants: z.array(
    z.discriminatedUnion('kind', [
      address.extend({
        kind: z.literal('diagnostic'),
        reason: z.enum([
          'corrupt',
          'unavailable',
          'unsupported',
          'identity_mismatch',
          'parent_unverified',
        ]),
      }),
      address.extend({
        kind: z.literal('child'),
        mode: z.enum(['one-shot', 'continuable']),
        label: z.string().optional(),
        // Exact Host-local Agent status: null is unknown, never inferred idle.
        running: z.boolean().nullable().default(null),
        // Own log only; task is the initial user message's first text block.
        title: z.string().optional(),
        task: z.string().optional(),
        // Inactive is native Host-local residency, not a terminal status.
        activity: z.enum(['running', 'inactive', 'unknown']),
        observation,
        timing: z.object({
          settledMs: z.number().nonnegative(),
          active: z
            .object({ since: z.number(), through: z.number() })
            .optional(),
          lastTurnCompleted: z.boolean().optional(),
        }),
        // Native cumulative view includes fork history; it is not a bill.
        usage: z.object({
          uncachedInputTokens: z.number().nonnegative(),
          cacheReadTokens: z.number().nonnegative(),
          cacheWriteTokens: z.number().nonnegative(),
          outputTokens: z.number().nonnegative(),
        }),
        lastReply: z.string().max(nativeChildViewLimits.text).nullable(),
        lastReplyTruncated: z.boolean().optional(),
      }),
    ]),
  ),
});
export type NativeSubagentSummary = z.infer<typeof NativeSubagentSummarySchema>;
