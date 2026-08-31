import { z } from 'zod';

import { UuidSchema } from './common.ts';

export const FrameworkSurfaceSchema = z.enum([
  'workspace',
  'employees',
  'automation',
  'model-pool',
]);
export type FrameworkSurface = z.infer<typeof FrameworkSurfaceSchema>;

export const FrameworkRolloutPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    emergencyOff: z.boolean().default(false),
    defaultEnabled: z.boolean().default(false),
    organizationIds: z.array(UuidSchema).default([]),
    workspaceIds: z.array(UuidSchema).default([]),
    employeeVersionIds: z.array(UuidSchema).default([]),
    surfaces: z.array(FrameworkSurfaceSchema).default([]),
  })
  .strict();
export type FrameworkRolloutPolicy = z.infer<
  typeof FrameworkRolloutPolicySchema
>;

export interface FrameworkRolloutContext {
  organizationId?: string | null;
  workspaceId?: string | null;
  employeeVersionId?: string | null;
  surface: FrameworkSurface;
}

function matchesScope(configured: string[], actual: string | null | undefined) {
  return (
    configured.length === 0 || Boolean(actual && configured.includes(actual))
  );
}

export function resolveFrameworkRollout(
  policyInput: FrameworkRolloutPolicy,
  context: FrameworkRolloutContext,
) {
  const policy = FrameworkRolloutPolicySchema.parse(policyInput);
  if (policy.emergencyOff) return false;
  if (policy.surfaces.length && !policy.surfaces.includes(context.surface)) {
    return false;
  }
  const hasScopedRollout =
    policy.organizationIds.length > 0 ||
    policy.workspaceIds.length > 0 ||
    policy.employeeVersionIds.length > 0;
  if (!hasScopedRollout) return policy.defaultEnabled;
  return (
    matchesScope(policy.organizationIds, context.organizationId) &&
    matchesScope(policy.workspaceIds, context.workspaceId) &&
    matchesScope(policy.employeeVersionIds, context.employeeVersionId)
  );
}
