import { z } from 'zod';
import { UuidSchema } from './common.ts';

export const workspaceCapabilityIds = [
  'report',
  'local_files',
  'changeset',
  'local_command',
  'cloud_command',
  'cloud_browser',
  'local_browser',
  'cloud_mcp',
  'local_mcp',
  'assistants',
  'development',
  'boost',
  'teamwork',
] as const;
export const WorkspaceCapabilityIdSchema = z.enum(workspaceCapabilityIds);
export type WorkspaceCapabilityId = z.infer<typeof WorkspaceCapabilityIdSchema>;
export const WorkspaceCapabilityStateSchema = z.enum([
  'ready',
  'needs_configuration',
  'needs_authorization',
  'device_offline',
  'not_released',
  'unknown',
]);
export const WorkspaceCapabilitySchema = z
  .object({
    id: WorkspaceCapabilityIdSchema,
    state: WorkspaceCapabilityStateSchema,
    reason: z.enum([
      'ready',
      'release_disabled',
      'planned',
      'employee_missing',
      'employee_policy',
      'policy_missing',
      'policy_denied',
      'read_only',
      'provider_unsupported',
      'bridge_missing',
      'bridge_offline',
      'folder_missing',
      'runner_missing',
      'candidate_runner_missing',
      'target_missing',
      'target_unavailable',
      'grant_missing',
      'connection_missing',
      'connection_unverified',
      'connection_grant_missing',
      'invalid_configuration',
    ]),
    target: z.enum(['cloud', 'local', 'cloud_or_local', 'none']),
    responsibleRole: z.enum(['user', 'tenant_admin', 'platform_admin']),
    action: z.enum([
      'compose',
      'bridge',
      'guide',
      'mcp_settings',
      'browser_settings',
      'local_browser_settings',
    ]),
    releaseEnabled: z.boolean(),
    authorization: z.enum([
      'normal_policy',
      'per_action',
      'root_budget',
      'unavailable',
    ]),
  })
  .strict();
export type WorkspaceCapability = z.infer<typeof WorkspaceCapabilitySchema>;

/** Discovery only. Never a token, grant, approval or admission authority. */
export const WorkspaceReadinessSchema = z
  .object({
    schemaVersion: z.literal(1),
    organizationId: UuidSchema,
    workspaceId: UuidSchema,
    viewerId: UuidSchema,
    sessionId: UuidSchema.nullable(),
    employeeVersionId: UuidSchema.nullable(),
    canAdminister: z.boolean(),
    observedAt: z.iso.datetime(),
    basis: z.literal('next_task'),
    capabilities: z
      .array(WorkspaceCapabilitySchema)
      .length(workspaceCapabilityIds.length),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.capabilities.map((c) => c.id)).size ===
      workspaceCapabilityIds.length,
  );
export type WorkspaceReadiness = z.infer<typeof WorkspaceReadinessSchema>;
