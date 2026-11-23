import { z } from 'zod';
import { UuidSchema } from './common.ts';
import {
  CorrectPersonalEmployeeMemoryInputSchema,
  EmployeeMemoryListQuerySchema,
  EmployeeMemoryMutationInputSchema,
} from './personal-employee-memory.ts';

/** Business selectors only. Authentication and module qualification are host-only. */
export const MemoryDetailQueryProjectionSchema =
  EmployeeMemoryListQuerySchema.extend({ memoryId: UuidSchema }).strict();

const MemoryCommandTargetSchema = z
  .object({ workspaceId: UuidSchema, memoryId: UuidSchema })
  .strict();

export const MemoryCorrectCommandProjectionSchema = z
  .object({
    target: MemoryCommandTargetSchema,
    body: CorrectPersonalEmployeeMemoryInputSchema,
  })
  .strict();

export const MemoryMutationCommandProjectionSchema = z
  .object({
    target: MemoryCommandTargetSchema,
    body: EmployeeMemoryMutationInputSchema,
  })
  .strict();

/** A real administrator keeps their own context; these fields select a target. */
export const MemoryAdminListQueryProjectionSchema = z
  .object({
    organizationId: UuidSchema,
    ownerId: UuidSchema,
    instanceId: UuidSchema,
  })
  .strict();
export const MemoryAdminDetailQueryProjectionSchema =
  MemoryAdminListQueryProjectionSchema.extend({
    memoryId: UuidSchema,
  }).strict();
export const MemoryAdminQueryProjectionSchema = z.union([
  MemoryAdminListQueryProjectionSchema,
  MemoryAdminDetailQueryProjectionSchema,
]);

export type MemoryDetailQueryProjection = z.input<
  typeof MemoryDetailQueryProjectionSchema
>;
export type MemoryCorrectCommandProjection = z.input<
  typeof MemoryCorrectCommandProjectionSchema
>;
export type MemoryMutationCommandProjection = z.input<
  typeof MemoryMutationCommandProjectionSchema
>;
export type MemoryAdminListQueryProjection = z.input<
  typeof MemoryAdminListQueryProjectionSchema
>;
export type MemoryAdminDetailQueryProjection = z.input<
  typeof MemoryAdminDetailQueryProjectionSchema
>;
