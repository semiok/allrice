import { z } from 'zod';
import { UuidSchema } from './common.ts';

// Product writer ownership, independent of the installed DSH distribution.
export const ExecutionGenerationSchema = z.enum(['3.x', '4.0']);
export type ExecutionGeneration = z.infer<typeof ExecutionGenerationSchema>;

// Selectors only. Tenant/person/native owner and transport targets are host facts.
export const DEntrySelectionInputSchema = z
  .object({
    workspaceId: UuidSchema,
    employeeInstanceId: UuidSchema,
    threadId: UuidSchema.optional(),
  })
  .strict();
export type DEntrySelectionInput = z.infer<typeof DEntrySelectionInputSchema>;

export const DEntryIdentitySchema = z
  .object({
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    personId: UuidSchema,
    employeeInstanceId: UuidSchema,
    employeeRevision: z.number().int().positive(),
    employeeVersionId: UuidSchema,
    threadId: UuidSchema.nullable(),
  })
  .strict();
export type DEntryIdentity = z.infer<typeof DEntryIdentitySchema>;
export function sameDEntryIdentity(a: DEntryIdentity, b: DEntryIdentity) {
  return (
    [
      'organizationId',
      'workspaceId',
      'personId',
      'employeeInstanceId',
      'employeeRevision',
      'employeeVersionId',
      'threadId',
    ] as const
  ).every((key) => a[key] === b[key]);
}
export const DEntryIdentityResultSchema = z
  .object({ identity: DEntryIdentitySchema })
  .strict();
export const DEntryAdmissionSchema = z
  .object({
    identity: DEntryIdentitySchema,
    executionGeneration: ExecutionGenerationSchema,
    policyRevision: z.string().min(1),
  })
  .strict();
export type DEntryAdmission = z.infer<typeof DEntryAdmissionSchema>;

// No env/default/list is created here. The approved release source must supply
// every field. Matching one person's employee never grants another's access.
export const DEntryRolloutPolicySchema = z
  .object({
    revision: z.string().min(1),
    defaultGeneration: ExecutionGenerationSchema,
    selections: z.array(
      z
        .object({
          organizationId: UuidSchema,
          personId: UuidSchema,
          employeeInstanceId: UuidSchema,
          generation: ExecutionGenerationSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const keys = new Set<string>();
    for (const [index, selection] of policy.selections.entries()) {
      const key = JSON.stringify([
        selection.organizationId,
        selection.personId,
        selection.employeeInstanceId,
      ]);
      if (keys.has(key))
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate employee selection',
          path: ['selections', index],
        });
      keys.add(key);
    }
  });
export type DEntryRolloutPolicy = z.infer<typeof DEntryRolloutPolicySchema>;

/** Selects a NEW thread's writer only; never changes a persisted thread pin. */
export function selectDEntryGeneration(
  policyInput: DEntryRolloutPolicy,
  identityInput: DEntryIdentity,
): ExecutionGeneration {
  const policy = DEntryRolloutPolicySchema.parse(policyInput);
  const identity = DEntryIdentitySchema.parse(identityInput);
  return (
    policy.selections.find(
      (selection) =>
        selection.organizationId === identity.organizationId &&
        selection.personId === identity.personId &&
        selection.employeeInstanceId === identity.employeeInstanceId,
    )?.generation ?? policy.defaultGeneration
  );
}

// Browser-safe mount references only; no guest URL, cookie, token or disk path.
// The runtime owner supplies an opaque binding reference that changes whenever
// the Host/profile/lease changes. The BFF alone resolves its transport.
export const DEntryMountSchema = z
  .object({
    identity: DEntryIdentitySchema,
    executionGeneration: ExecutionGenerationSchema,
    bindingRef: z.string().min(1),
    remountKey: z.string().min(1),
  })
  .strict();
export type DEntryMount = z.infer<typeof DEntryMountSchema>;

// 271-owned wire boundary for the frozen native-owner v1 discovery seam.
// These schemas validate a consumed projection; they do not construct or
// replace 273's provider receipt or attest that a native job is ready.
export const DEntryNativeOwnerRequestSchema = z
  .object({
    organizationId: UuidSchema,
    selection: DEntrySelectionInputSchema,
  })
  .strict();
export const DEntryNativeResourceRequestSchema = z
  .object({
    organizationId: UuidSchema,
    selection: DEntrySelectionInputSchema.extend({ threadId: UuidSchema }),
    nativeSessionId: z.string().min(1),
  })
  .strict();
export const DEntryNativeResourceFactsSchema = z
  .object({
    organizationId: UuidSchema,
    personId: UuidSchema,
    employeeInstanceId: UuidSchema,
    threadId: UuidSchema,
    nativeSessionId: z.string().min(1),
    rootNativeSessionId: z.string().min(1),
    parentNativeSessionId: z.string().min(1).nullable(),
    bindingRef: z.string().min(1),
  })
  .strict();
export type DEntryNativeResourceFacts = z.infer<
  typeof DEntryNativeResourceFactsSchema
>;

export const DEntryNativeRpcRequestSchema = z
  .object({
    selection: DEntrySelectionInputSchema.extend({ threadId: UuidSchema }),
    endpoint: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();
export const DEntryNativeDiscoverySchema = z
  .object({
    identity: DEntryIdentitySchema,
    bindingRef: z.string().min(1),
    controlReady: z.boolean(),
  })
  .strict();
