import { z } from 'zod';

// Display bounds only: they never constrain the native execution or journal.
export const nativeChildViewLimits = {
  events: 128,
  text: 16_384,
  chunks: 2_048,
  streamCharacters: 32_768,
} as const;
const seq = z.number().int().nonnegative();
const cursor = z.number().int().min(-1);
const text = z.object({
  text: z.string().max(nativeChildViewLimits.text),
  truncated: z.boolean(),
});
export const NativeSubagentSnapshotSchema = z.object({
  rootId: z.string(),
  childId: z.string(),
  hostEpoch: seq,
  observation: z.object({ source: z.literal('live'), cursor }),
  inheritedEventCount: seq,
  window: z.object({
    fromSeq: seq.nullable(),
    omittedEvents: seq,
    omittedRows: seq,
  }),
  task: text.extend({ seq }).nullable(),
  rows: z
    .array(
      z.discriminatedUnion('kind', [
        text.extend({
          kind: z.literal('assistant'),
          seq,
          turn: seq,
          step: seq,
        }),
        z.object({
          kind: z.literal('tool'),
          seq,
          turn: seq,
          step: seq,
          callId: z.string().max(512),
          name: z.string().max(160),
          activityDetail: z.string().max(500).optional(),
          truncated: z.boolean(),
          result: z
            .object({ seq, failed: z.boolean(), summary: z.string() })
            .optional(),
        }),
      ]),
    )
    .max(nativeChildViewLimits.events),
  stream: z.object({
    // Host-local display binding to the exact public Agent object, not native state.
    instanceId: z.string(),
    revision: seq,
    complete: z.boolean(),
    active: text
      .extend({
        attemptId: z.string(),
        turn: seq,
        step: seq,
        startedAfterSeq: cursor,
        nextIndex: seq,
      })
      .nullable(),
  }),
});
export type NativeSubagentSnapshot = z.infer<
  typeof NativeSubagentSnapshotSchema
>;
