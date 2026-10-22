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

/** Wall-clock daily and elapsed-time intervals have different semantics. */
export const RecurringScheduleRuleSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('every'),
      seconds: z.number().int().min(60).max(31_536_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('daily'),
      time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
      timezone: TimezoneSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('weekly'),
      time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
      timezone: TimezoneSchema,
      /** Canonical ISO weekdays: Monday 1 through Sunday 7. */
      weekdays: z
        .array(z.number().int().min(1).max(7))
        .min(1)
        .max(7)
        .refine(
          (days) => days.every((day, i) => i === 0 || day > days[i - 1]!),
          'Choose unique ascending ISO weekdays',
        ),
    })
    .strict(),
]);
export type RecurringScheduleRule = z.infer<typeof RecurringScheduleRuleSchema>;

const TaskContent = {
  name: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(40_000),
  rule: RecurringScheduleRuleSchema,
};

/** The authenticated current chat determines the company, employee and owner. */
export const CreateRecurringTaskInputSchema = z
  .object({
    clientRequestId: UuidSchema,
    ...TaskContent,
  })
  .strict();
export type CreateRecurringTaskInput = z.infer<
  typeof CreateRecurringTaskInputSchema
>;

export const RecurringOccurrenceSchema = z
  .object({
    id: UuidSchema,
    taskId: UuidSchema,
    revision: z.number().int().positive().safe(),
    scheduledAt: TimestampSchema,
    status: z.enum([
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
  })
  .strict();
export type RecurringOccurrence = z.infer<typeof RecurringOccurrenceSchema>;

export const RecurringTaskSchema = z
  .object({
    id: UuidSchema,
    clientRequestId: UuidSchema,
    sessionId: UuidSchema,
    ...TaskContent,
    revision: z.number().int().positive().safe(),
    status: z.enum([
      'preparing',
      'enabled',
      'paused',
      'deleting',
      'deleted',
      'failed',
    ]),
    nextRunAt: TimestampSchema.nullable(),
    errorMessage: z.string().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    canManage: z.boolean(),
    latestOccurrence: RecurringOccurrenceSchema.nullable(),
  })
  .strict();
export type RecurringTask = z.infer<typeof RecurringTaskSchema>;

const OperationIdentity = {
  operationId: UuidSchema,
  expectedRevision: z.number().int().positive().safe(),
};
export const ChangeRecurringTaskInputSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...OperationIdentity,
      action: z.literal('update'),
      ...TaskContent,
    })
    .strict(),
  z.object({ ...OperationIdentity, action: z.literal('pause') }).strict(),
  z.object({ ...OperationIdentity, action: z.literal('resume') }).strict(),
  z.object({ ...OperationIdentity, action: z.literal('delete') }).strict(),
]);
export type ChangeRecurringTaskInput = z.infer<
  typeof ChangeRecurringTaskInputSchema
>;

/** An exact operation readback, including the original request, resolves unknown writes. */
export const RecurringTaskOperationSchema = z
  .object({
    operationId: UuidSchema,
    taskId: UuidSchema,
    request: ChangeRecurringTaskInputSchema,
    status: z.enum(['pending', 'applied', 'rejected']),
    errorMessage: z.string().nullable(),
    task: RecurringTaskSchema.nullable(),
  })
  .strict();
export type RecurringTaskOperation = z.infer<
  typeof RecurringTaskOperationSchema
>;

const Cursor = z.string().min(1).max(4096);
export const RecurringTaskListSchema = z
  .object({
    tasks: z.array(RecurringTaskSchema).max(50),
    /** Only exact clientRequestId lookups return the immutable original input. */
    request: CreateRecurringTaskInputSchema.nullable(),
    enabled: z.boolean(),
    nextCursor: Cursor.nullable(),
  })
  .strict();
export const RecurringTaskHistorySchema = z
  .object({
    task: RecurringTaskSchema,
    occurrences: z.array(RecurringOccurrenceSchema).max(50),
    nextCursor: Cursor.nullable(),
  })
  .strict();
export const RecurringTaskListQuerySchema = z
  .object({
    clientRequestId: UuidSchema.optional(),
    cursor: Cursor.optional(),
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
export const RecurringTaskDetailQuerySchema = z
  .object({
    operationId: UuidSchema.optional(),
    cursor: Cursor.optional(),
  })
  .strict()
  .refine(
    (value) => value.operationId === undefined || value.cursor === undefined,
    {
      message: 'An exact operation lookup cannot be paginated',
      path: ['cursor'],
    },
  );
