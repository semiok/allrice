import { z } from 'zod';

const milliseconds = z.number().int().nonnegative();
/** Presentation-safe projection; call attempts are not provider usage receipts. */
export const TaskRuntimeTimingSchema = z
  .object({
    activeMs: milliseconds,
    waitingMs: milliseconds,
    wallMs: milliseconds,
    timeoutMs: milliseconds,
    remainingMs: milliseconds.nullable(),
    phase: z.enum(['queued', 'active', 'waiting', 'terminal']),
    sources: z.array(
      z.object({ scope: z.string(), timeoutMs: milliseconds }).strict(),
    ),
    calls: z
      .object({
        modelRequests: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        pending: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type TaskRuntimeTiming = z.infer<typeof TaskRuntimeTimingSchema>;
