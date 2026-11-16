import { z } from 'zod';
import { TimestampSchema, UuidSchema } from './common.ts';

/** Exact published content; display names never identify a capability. */
export const EmployeeModuleReleaseSchema = z
  .object({
    moduleId: z.string().min(1).max(160),
    contractVersion: z.literal(1),
    contentVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export const EmployeeModuleScopeSchema = z
  .object({
    workspaceId: UuidSchema.transform((v) => v.toLowerCase()),
    instanceId: UuidSchema.transform((v) => v.toLowerCase()),
  })
  .strict();
export const EmployeeModuleBindingSchema = z
  .object({
    ...EmployeeModuleScopeSchema.shape,
    organizationId: UuidSchema,
    ownerId: UuidSchema,
    release: EmployeeModuleReleaseSchema,
    revision: z.number().int().positive(),
    enabledAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict();
export const AddEmployeeModuleInputSchema = z
  .object({
    ...EmployeeModuleScopeSchema.shape,
    requestId: UuidSchema.transform((v) => v.toLowerCase()),
    release: EmployeeModuleReleaseSchema,
  })
  .strict();
export type EmployeeModuleRelease = z.infer<typeof EmployeeModuleReleaseSchema>;
export type EmployeeModuleBinding = z.infer<typeof EmployeeModuleBindingSchema>;
