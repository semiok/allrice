import { z } from 'zod';
import { UuidSchema } from './common.ts';
import {
  PlatformEmployeeRevisionSchema,
  PlatformEmployeeStatusSchema,
} from './platform-employees.ts';

export const PlatformEmployeeHistoryQuerySchema = z
  .object({
    search: z.string().trim().max(160).optional(),
    after: UuidSchema.optional(),
  })
  .strict();
export const PlatformEmployeeHistoryTemplateSchema = z
  .object({
    id: UuidSchema,
    employeeKey: z.string(),
    name: z.string(),
    status: PlatformEmployeeStatusSchema,
  })
  .strict();
export const PlatformEmployeeHistoryDirectorySchema = z
  .object({
    employees: z.array(PlatformEmployeeHistoryTemplateSchema).max(50),
    nextCursor: UuidSchema.nullable(),
  })
  .strict();
export const PlatformEmployeeHistoryRevisionSchema =
  PlatformEmployeeRevisionSchema.omit({
    definition: true,
    runtimeProfile: true,
  });
export const PlatformEmployeeHistorySchema = z
  .object({
    employee: PlatformEmployeeHistoryTemplateSchema,
    revisions: z.array(PlatformEmployeeHistoryRevisionSchema).max(50),
    nextBefore: z.number().int().positive().nullable(),
  })
  .strict();
export const PlatformEmployeeRevisionHistoryQuerySchema = z
  .object({
    before: z.coerce.number().int().positive().optional(),
  })
  .strict();
export type PlatformEmployeeHistory = z.infer<
  typeof PlatformEmployeeHistorySchema
>;
export type PlatformEmployeeHistoryTemplate = z.infer<
  typeof PlatformEmployeeHistoryTemplateSchema
>;
