import { z } from 'zod';

import { UuidSchema } from './common.ts';
import { RunEventSchema, type RunEvent } from './runs.ts';

export const SseCursorSchema = z
  .object({ runId: UuidSchema, sequence: z.number().int().nonnegative() })
  .strict();
export type SseCursor = z.infer<typeof SseCursorSchema>;

export function formatSseCursor(cursorInput: SseCursor) {
  const cursor = SseCursorSchema.parse(cursorInput);
  return `${cursor.runId}:${cursor.sequence}`;
}

export function parseSseCursor(value: string): SseCursor {
  const separator = value.lastIndexOf(':');
  if (separator < 1) throw new Error('cursor_invalid');
  const runId = value.slice(0, separator);
  const sequence = Number(value.slice(separator + 1));
  const parsed = SseCursorSchema.safeParse({ runId, sequence });
  if (!parsed.success) throw new Error('cursor_invalid');
  return parsed.data;
}

export function replayRunEvents(
  eventsInput: RunEvent[],
  lastEventId: string | undefined,
  earliestAvailableSequence = 0,
) {
  const events = eventsInput.map((event) => RunEventSchema.parse(event));
  if (!lastEventId) return events;
  const cursor = parseSseCursor(lastEventId);
  if (events.some((event) => event.runId !== cursor.runId)) {
    throw new Error('cursor_forbidden');
  }
  if (cursor.sequence < earliestAvailableSequence - 1) {
    throw new Error('cursor_expired');
  }
  return events.filter((event) => event.sequence > cursor.sequence);
}
