import { z } from 'zod';
import { UuidSchema } from './common.ts';
import {
  EmployeeModuleBindingSchema,
  EmployeeModuleReleaseSchema,
} from './employee-modules.ts';

const uuid = UuidSchema.transform((value) => value.toLowerCase());
// Native references, B and producer proof bytes are opaque. Their byte/key
// contract remains with the real producer; parsing never authenticates them.
const opaque = z.string().min(1);

export const EmployeeBusinessScopeProjectionSchema = z
  .object({
    organizationId: uuid,
    workspaceId: uuid,
    ownerId: uuid,
    employeeInstanceId: uuid,
    employeeId: uuid,
  })
  .strict();

const moduleRequirement = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not-applicable') }).strict(),
  z
    .object({
      kind: z.literal('required'),
      release: EmployeeModuleReleaseSchema,
    })
    .strict(),
]);

export const EmployeeBusinessTargetProjectionSchema = z
  .object({
    workspaceId: uuid,
    employeeInstanceId: uuid,
    threadId: uuid.nullable(),
    access: z.enum(['management', 'history', 'execute']),
    module: moduleRequirement,
  })
  .strict()
  .refine((value) => value.access !== 'execute' || value.threadId !== null, {
    message: 'execution requires a thread',
    path: ['threadId'],
  });

export const CurrentEmployeeBusinessProjectionSchema = z
  .object({
    scope: EmployeeBusinessScopeProjectionSchema,
    threadId: uuid.nullable(),
    access: z.enum(['management', 'history', 'execute']),
    identityRevisionRef: opaque,
    executionGeneration: z.literal('4.0').nullable(),
    module: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('not-applicable') }).strict(),
      z
        .object({
          kind: z.literal('required'),
          binding: EmployeeModuleBindingSchema,
          configDigest: opaque,
        })
        .strict(),
    ]),
  })
  .strict();

export const AdministrationTargetProjectionSchema = z
  .object({ organizationId: uuid, operation: opaque, targetRef: opaque })
  .strict();

const executionTarget = {
  workspaceId: uuid,
  employeeInstanceId: uuid,
  threadId: uuid,
};
export const ActualNativeExecutionSelectorProjectionSchema = z
  .object({ ...executionTarget, nativeRequestRef: opaque })
  .strict();
export const OriginalExecutionSelectorProjectionSchema = z
  .object({ ...executionTarget, b: opaque })
  .strict();

export const ActualNativeCallProjectionSchema = z
  .object({
    rootSessionRef: opaque,
    parentSessionRef: opaque.nullable(),
    sessionRef: opaque,
    callRef: opaque,
    toolId: opaque,
    toolVersion: opaque,
  })
  .strict();

export const LogicalExecutionBindingProjectionSchema = z
  .object({
    scope: EmployeeBusinessScopeProjectionSchema,
    threadId: uuid,
    executionGeneration: z.literal('4.0'),
    b: opaque,
    executionBoundaryRef: opaque,
    rootOriginRef: opaque,
    rootSessionRef: opaque,
    nativeCall: ActualNativeCallProjectionSchema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.nativeCall === null ||
      value.nativeCall.rootSessionRef === value.rootSessionRef,
    { message: 'call must belong to the original root', path: ['nativeCall'] },
  );

export const ActualNativeCallSelectorProjectionSchema = z
  .object({
    scope: EmployeeBusinessScopeProjectionSchema,
    threadId: uuid,
    b: opaque,
    executionBoundaryRef: opaque,
    rootOriginRef: opaque,
    nativeCall: ActualNativeCallProjectionSchema,
  })
  .strict();
export const StoredHumanSourceSelectorProjectionSchema =
  ActualNativeCallSelectorProjectionSchema.extend({ sourceRef: opaque });

const humanSource = {
  ...ActualNativeCallSelectorProjectionSchema.shape,
  sourceRef: opaque,
  proof: z.object({ version: opaque, digest: opaque }).strict(),
  accessRevisionRef: opaque,
};
export const AdoptedHumanSourceProjectionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...humanSource,
      kind: z.literal('ordinary-human-message'),
    })
    .strict(),
  z
    .object({
      ...humanSource,
      kind: z.literal('adopted-steering'),
      adoptedByExecution: z.literal(true),
    })
    .strict(),
]);

export const MemoryOriginSelectorProjectionSchema = z
  .object({
    // These are the existing record's fields, supplied by its owner. The
    // authorized organization/workspace stays inside the caller closure.
    sourceType: z.string(),
    sourceId: z.string().nullable(),
  })
  .strict();

export const OrdinaryOriginClassificationProjectionSchema =
  z.discriminatedUnion('sourceCheck', [
    z
      .object({
        sourceCheck: z.literal('checked'),
        excludedByMethodAuthoring: z.boolean(),
      })
      .strict(),
    z
      .object({
        sourceCheck: z.literal('not-applicable'),
        excludedByMethodAuthoring: z.literal(false),
      })
      .strict(),
  ]);

export type EmployeeBusinessScopeProjection = z.infer<
  typeof EmployeeBusinessScopeProjectionSchema
>;
export type EmployeeBusinessTargetProjection = z.infer<
  typeof EmployeeBusinessTargetProjectionSchema
>;
export type CurrentEmployeeBusinessProjection = z.infer<
  typeof CurrentEmployeeBusinessProjectionSchema
>;
export type AdministrationTargetProjection = z.infer<
  typeof AdministrationTargetProjectionSchema
>;
export type ActualNativeExecutionSelectorProjection = z.infer<
  typeof ActualNativeExecutionSelectorProjectionSchema
>;
export type OriginalExecutionSelectorProjection = z.infer<
  typeof OriginalExecutionSelectorProjectionSchema
>;
export type LogicalExecutionBindingProjection = z.infer<
  typeof LogicalExecutionBindingProjectionSchema
>;
export type ActualNativeCallSelectorProjection = z.infer<
  typeof ActualNativeCallSelectorProjectionSchema
>;
export type StoredHumanSourceSelectorProjection = z.infer<
  typeof StoredHumanSourceSelectorProjectionSchema
>;
export type AdoptedHumanSourceProjection = z.infer<
  typeof AdoptedHumanSourceProjectionSchema
>;
export type MemoryOriginSelectorProjection = z.infer<
  typeof MemoryOriginSelectorProjectionSchema
>;
export type OrdinaryOriginClassificationProjection = z.infer<
  typeof OrdinaryOriginClassificationProjectionSchema
>;
