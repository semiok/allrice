import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

const TimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Choose an IANA timezone');

/** The server derives the owner and AI employee from the current chat. */
export const CreateOnceTaskInputSchema = z
  .object({
    clientRequestId: UuidSchema,
    name: z.string().trim().min(1).max(160),
    prompt: z.string().trim().min(1).max(40_000),
    runAt: TimestampSchema,
    timezone: TimezoneSchema,
  })
  .strict();
export type CreateOnceTaskInput = z.infer<typeof CreateOnceTaskInputSchema>;

export const OnceTaskSchema = z
  .object({
    id: UuidSchema,
    clientRequestId: UuidSchema,
    name: z.string().min(1).max(160),
    prompt: z.string().min(1).max(40_000),
    sessionId: UuidSchema,
    runAt: TimestampSchema,
    timezone: TimezoneSchema,
    status: z.enum([
      'preparing',
      'pending',
      'queued',
      'running',
      'awaiting_input',
      'succeeded',
      'failed',
      'canceled',
      'not_executed',
    ]),
    runId: UuidSchema.nullable(),
    errorMessage: z.string().nullable(),
    createdAt: TimestampSchema,
    canCancel: z.boolean(),
  })
  .strict();
export type OnceTask = z.infer<typeof OnceTaskSchema>;

export const OnceTaskListSchema = z
  .object({
    tasks: z.array(OnceTaskSchema).max(50),
    enabled: z.boolean(),
    nextCursor: z.string().min(1).max(4096).nullable(),
  })
  .strict();
export type OnceTaskList = z.infer<typeof OnceTaskListSchema>;

/** Cursor bytes belong to the database; clients only retain and return them. */
export const OnceTaskListQuerySchema = z
  .object({
    clientRequestId: UuidSchema.optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.clientRequestId === undefined || value.cursor === undefined,
    {
      message: 'An exact request lookup cannot be paginated',
      path: ['cursor'],
    },
  );
export type OnceTaskListQuery = z.infer<typeof OnceTaskListQuerySchema>;
