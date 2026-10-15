import { z } from 'zod';
import { UuidSchema } from './common.ts';
import { ContentMaintenanceLevelSchema } from './content-maintenance.ts';
import { EmployeeVersionSourceSchema } from './employees.ts';
import { EmployeeDetailsSchema } from './employee-details.ts';

export const OrganizationAiDirectoryQuerySchema = z
  .object({
    search: z.string().trim().max(160).optional(),
    departmentId: z.union([UuidSchema, z.literal('unassigned')]).optional(),
    kind: z.enum(['general', 'custom']).optional(),
    sourceTemplate: z.union([UuidSchema, z.literal('legacy')]).optional(),
    after: UuidSchema.optional(),
  })
  .strict();
export type OrganizationAiDirectoryQuery = z.infer<
  typeof OrganizationAiDirectoryQuerySchema
>;

const count = z.number().int().nonnegative();
export const OrganizationAiCountsSchema = z
  .object({
    general: count,
    custom: count,
    inactive: count,
    archived: count,
    pendingAssignments: count,
  })
  .strict();
export const OrganizationAiPersonSchema = z
  .object({
    userId: UuidSchema,
    username: z.string().nullable(),
    displayName: z.string(),
    jobTitle: z.string(),
    departmentId: UuidSchema.nullable(),
    departmentName: z.string().nullable(),
    departmentActive: z.boolean(),
    active: z.boolean(),
    maintenanceLevel: ContentMaintenanceLevelSchema,
    counts: OrganizationAiCountsSchema,
  })
  .strict();
export const OrganizationAiDirectorySchema = z
  .object({
    organizationId: UuidSchema,
    // Totals cover the current filters, not just the loaded page.
    totals: OrganizationAiCountsSchema.extend({ people: count }),
    people: z.array(OrganizationAiPersonSchema).max(50),
    nextCursor: UuidSchema.nullable(),
  })
  .strict();

export const OrganizationAiInstanceSchema = z
  .object({
    id: UuidSchema,
    employeeId: UuidSchema,
    assignmentId: UuidSchema,
    workspaceId: UuidSchema,
    workspaceName: z.string(),
    kind: z.enum(['general', 'custom']),
    state: z.enum([
      'active',
      'owner_inactive',
      'assignment_unavailable',
      'archived',
    ]),
    // Directory metadata never includes the private instance profile.
    sourceName: z.string(),
    source: EmployeeVersionSourceSchema,
    revision: z.number().int().positive(),
    updatedAt: z.string(),
    sharedSummary: z
      .object({
        sceneCount: count,
        referenceCount: count,
        automaticExperience: z.literal('not_enabled'),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const OrganizationPersonAiInstancesSchema = z
  .object({
    organizationId: UuidSchema,
    person: OrganizationAiPersonSchema,
    instances: z.array(OrganizationAiInstanceSchema).max(50),
    nextCursor: UuidSchema.nullable(),
  })
  .strict();
export type OrganizationAiDirectory = z.infer<
  typeof OrganizationAiDirectorySchema
>;
export type OrganizationAiPerson = z.infer<typeof OrganizationAiPersonSchema>;
export type OrganizationAiInstance = z.infer<
  typeof OrganizationAiInstanceSchema
>;
export type OrganizationPersonAiInstances = z.infer<
  typeof OrganizationPersonAiInstancesSchema
>;

export const OrganizationAiSharedDetailsSchema = z
  .object({
    organizationId: UuidSchema,
    userId: UuidSchema,
    visibility: z.literal('shared_only'),
    details: EmployeeDetailsSchema,
  })
  .strict();
