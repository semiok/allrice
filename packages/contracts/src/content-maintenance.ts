import { z } from 'zod';
import { UuidSchema } from './common.ts';

export const ContentMaintenanceLevelSchema = z.enum([
  'personal',
  'department',
  'company',
]);
export type ContentMaintenanceLevel = z.infer<
  typeof ContentMaintenanceLevelSchema
>;
export const contentMaintenanceLabels: Record<ContentMaintenanceLevel, string> =
  {
    personal: '个人',
    department: '部门',
    company: '公司',
  };

/** These scopes describe content ownership, never execution workspaces or
 * permission to administer accounts. Load targets from stored content. */
export const ContentOwnershipSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('platform') }).strict(),
  z
    .object({ scope: z.literal('company'), organizationId: UuidSchema })
    .strict(),
  z
    .object({
      scope: z.literal('department'),
      organizationId: UuidSchema,
      departmentId: UuidSchema,
    })
    .strict(),
  z
    .object({
      scope: z.literal('personal'),
      organizationId: UuidSchema,
      ownerId: UuidSchema,
    })
    .strict(),
]);
export type ContentOwnership = z.infer<typeof ContentOwnershipSchema>;
export const ContentAccessReasonSchema = z.enum([
  'allowed',
  'inactive_identity',
  'foreign_company',
  'private_owner_only',
  'department_unavailable',
  'other_department',
  'maintenance_level_required',
  'read_only_membership',
  'platform_read_only',
]);
export const ContentAccessDecisionSchema = z
  .object({
    canRead: z.boolean(),
    canMaintain: z.boolean(),
    readReason: ContentAccessReasonSchema,
    maintenanceReason: ContentAccessReasonSchema,
  })
  .strict();
export type ContentAccessDecision = z.infer<typeof ContentAccessDecisionSchema>;

/** Internal current principal: callers obtain it from live database authority,
 * not request JSON, membership role claims, a model, or a frozen Run snapshot. */
export interface ContentPrincipal {
  userId: string;
  organizationId: string;
  departmentId: string | null;
  maintenanceLevel: ContentMaintenanceLevel;
  writable: boolean;
}

export function evaluateContentAccess(
  principal: ContentPrincipal | null,
  ownership: ContentOwnership,
): ContentAccessDecision {
  const deny = (
    reason: ContentAccessDecision['readReason'],
  ): ContentAccessDecision => ({
    canRead: false,
    canMaintain: false,
    readReason: reason,
    maintenanceReason: reason,
  });
  if (!principal) return deny('inactive_identity');
  if (ownership.scope === 'platform')
    return {
      canRead: true,
      canMaintain: false,
      readReason: 'allowed',
      maintenanceReason: 'platform_read_only',
    };
  if (ownership.organizationId !== principal.organizationId)
    return deny('foreign_company');
  if (ownership.scope === 'personal' && ownership.ownerId !== principal.userId)
    return deny('private_owner_only');
  if (
    ownership.scope === 'department' &&
    ownership.departmentId !== principal.departmentId &&
    principal.maintenanceLevel !== 'company'
  )
    return deny('other_department');
  const levelAllowed =
    ownership.scope === 'personal' ||
    principal.maintenanceLevel === 'company' ||
    (ownership.scope === 'department' &&
      principal.maintenanceLevel === 'department');
  const reason = !principal.writable
    ? 'read_only_membership'
    : levelAllowed
      ? 'allowed'
      : 'maintenance_level_required';
  return {
    canRead: true,
    canMaintain: reason === 'allowed',
    readReason: 'allowed',
    maintenanceReason: reason,
  };
}
