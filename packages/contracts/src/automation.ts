import { z } from 'zod';

import { TimestampSchema, UuidSchema } from './common.ts';

export const AutomationStatusSchema = z.enum(['enabled', 'paused']);
export type AutomationStatus = z.infer<typeof AutomationStatusSchema>;

export const AutomationTriggerTypeSchema = z.enum(['schedule']);
export type AutomationTriggerType = z.infer<typeof AutomationTriggerTypeSchema>;

export const AutomationFrequencySchema = z.enum(['once', 'daily', 'weekly']);
export type AutomationFrequency = z.infer<typeof AutomationFrequencySchema>;

export const AutomationConversationModeSchema = z.enum([
  'new_each_run',
  'reuse',
]);
export type AutomationConversationMode = z.infer<
  typeof AutomationConversationModeSchema
>;

export const AutomationScheduleSchema = z
  .object({
    frequency: AutomationFrequencySchema,
    runAt: TimestampSchema.optional(),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    timezone: z.string().min(1).max(64).default('Asia/Shanghai'),
  })
  .strict()
  .superRefine((schedule, ctx) => {
    if (schedule.frequency === 'once' && !schedule.runAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['runAt'],
        message: 'once schedules require runAt',
      });
    }
    if (schedule.frequency !== 'once' && !schedule.time) {
      ctx.addIssue({
        code: 'custom',
        path: ['time'],
        message: 'recurring schedules require time',
      });
    }
    if (schedule.frequency === 'weekly' && schedule.weekday === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['weekday'],
        message: 'weekly schedules require a weekday',
      });
    }
  });
export type AutomationSchedule = z.infer<typeof AutomationScheduleSchema>;

export const AutomationSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    ownerId: UuidSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(1_000),
    prompt: z.string().min(1).max(40_000),
    triggerType: AutomationTriggerTypeSchema,
    schedule: AutomationScheduleSchema,
    status: AutomationStatusSchema,
    conversationMode: AutomationConversationModeSchema,
    employeeAssignmentId: UuidSchema.nullable(),
    lastSessionId: UuidSchema.nullable(),
    nextRunAt: TimestampSchema.nullable(),
    lastRunAt: TimestampSchema.nullable(),
    lastRunStatus: z
      .enum(['queued', 'running', 'succeeded', 'failed', 'canceled'])
      .nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type Automation = z.infer<typeof AutomationSchema>;

export const CreateAutomationInputSchema = z
  .object({
    workspaceId: UuidSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1_000).default(''),
    prompt: z.string().trim().min(1).max(40_000),
    triggerType: AutomationTriggerTypeSchema.default('schedule'),
    schedule: AutomationScheduleSchema,
    conversationMode: AutomationConversationModeSchema.default('new_each_run'),
    employeeAssignmentId: UuidSchema.nullable().optional(),
    enabled: z.boolean().default(true),
  })
  .strict();
export type CreateAutomationInput = z.infer<typeof CreateAutomationInputSchema>;

export const UpdateAutomationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(1_000).optional(),
    prompt: z.string().trim().min(1).max(40_000).optional(),
    schedule: AutomationScheduleSchema.optional(),
    conversationMode: AutomationConversationModeSchema.optional(),
    employeeAssignmentId: UuidSchema.nullable().optional(),
    status: AutomationStatusSchema.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'at least one update is required',
  );

export const AutomationRunSchema = z
  .object({
    id: UuidSchema,
    automationId: UuidSchema,
    runId: UuidSchema.nullable(),
    sessionId: UuidSchema.nullable(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    scheduledFor: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    completedAt: TimestampSchema.nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: TimestampSchema,
  })
  .strict();
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
