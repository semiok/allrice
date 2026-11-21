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
