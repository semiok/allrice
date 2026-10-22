import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';
import { OnceTaskSchema } from './native-schedule.ts';
import {
  RecurringTaskSchema,
  RecurringOccurrenceSchema,
} from './recurring-schedule.ts';
import { AutomationScheduleSchema } from './automation.ts';
import { AutomationOccurrenceSourceSchema } from './automation-manual.ts';

/** AllRice-owned presentation contract; native clock records stay in the adapter. */
export const AutomationCatalogTaskSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    prompt: z.string(),
    employeeId: UuidSchema.nullable(),
    employeeName: z.string(),
    sessionId: UuidSchema.nullable(),
    sessionTitle: z.string().nullable(),
    sourceArchived: z.boolean(),
    createdAt: TimestampSchema,
    nextRunAt: TimestampSchema.nullable(),
    canStop: z.boolean(),
    canRunNow: z.boolean().optional(),
    revision: z.number().int().positive().optional(),
    definition: z.discriminatedUnion('kind', [
      z
        .object({ kind: z.literal('recurring'), task: RecurringTaskSchema })
        .strict(),
      z.object({ kind: z.literal('once'), task: OnceTaskSchema }).strict(),
      z
        .object({
          kind: z.literal('legacy'),
          schedule: AutomationScheduleSchema,
          status: z.enum(['enabled', 'paused', 'deleted']),
          revision: z.number().int().positive(),
          canManage: z.boolean(),
        })
        .strict(),
    ]),
  })
  .strict();
export type AutomationCatalogTask = z.infer<typeof AutomationCatalogTaskSchema>;
export const AutomationCatalogQuerySchema = z
  .object({
    workspaceId: UuidSchema,
    query: z.string().trim().max(160).optional(),
    employeeId: UuidSchema.optional(),
    sessionId: UuidSchema.optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();
export const AutomationCatalogSchema = z
  .object({
    tasks: z.array(AutomationCatalogTaskSchema).max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
export const AutomationCatalogHistorySchema = z
  .object({
    task: AutomationCatalogTaskSchema,
    occurrences: z
      .array(
        RecurringOccurrenceSchema.extend({
          sessionId: UuidSchema.nullable(),
          source: AutomationOccurrenceSourceSchema.optional(),
        }),
      )
      .max(50),
    nextCursor: z.string().nullable(),
  })
  .strict();
