import { z } from 'zod';

import {
  ActorSchema,
  ResourceRefSchema,
  TimestampSchema,
  UuidSchema,
  type ResourceRef,
} from './common.ts';

export const RoleSchema = z.enum(['admin', 'member', 'viewer']);
export type Role = z.infer<typeof RoleSchema>;

export const ActionSchema = z.enum([
  'resource:read',
  'resource:write',
  'resource:share',
  'resource:delete',
  'job:execute',
  'approval:decide',
  'settings:manage',
  'secret:use',
]);
export type Action = z.infer<typeof ActionSchema>;

export const MembershipSchema = z
  .object({
    id: UuidSchema,
    userId: UuidSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    role: RoleSchema,
    active: z.boolean(),
  })
  .strict();
export type Membership = z.infer<typeof MembershipSchema>;

export const RequestContextSchema = z
  .object({
    requestId: UuidSchema,
    sessionId: UuidSchema,
    actor: ActorSchema,
    organizationId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    memberships: z.array(MembershipSchema),
    authenticatedAt: TimestampSchema,
  })
  .strict();
export type RequestContext = z.infer<typeof RequestContextSchema>;

export const PolicyGrantSchema = z
  .object({
    resourceType: z.string().min(1).max(64),
    action: ActionSchema,
    workspaceId: UuidSchema.nullable(),
  })
  .strict();

export const PolicySnapshotSchema = z
  .object({
    id: UuidSchema,
    organizationId: UuidSchema,
    subjectId: UuidSchema,
    version: z.number().int().positive(),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    memberships: z.array(MembershipSchema),
    grants: z.array(PolicyGrantSchema),
  })
  .strict();
export type PolicySnapshot = z.infer<typeof PolicySnapshotSchema>;

export const ExecutionContextSchema = z
  .object({
    executionId: UuidSchema,
    runId: UuidSchema,
    jobId: UuidSchema,
    worker: ActorSchema.refine((actor) => actor.type === 'worker'),
    delegatedBy: ActorSchema.refine(
      (actor) => actor.type === 'user' || actor.type === 'service',
    ),
    organizationId: UuidSchema,
    workspaceId: UuidSchema.nullable(),
    policySnapshot: PolicySnapshotSchema,
    startedAt: TimestampSchema,
  })
  .strict();
export type ExecutionContext = z.infer<typeof ExecutionContextSchema>;

export type AuthorizationReason =
  | 'allowed_owner'
  | 'allowed_membership'
  | 'allowed_explicit_grant'
  | 'denied_unauthenticated_actor'
  | 'denied_tenant_mismatch'
  | 'denied_workspace_mismatch'
  | 'denied_private_resource'
  | 'denied_archived_resource'
  | 'denied_role';

export interface AuthorizationDecision {
  allowed: boolean;
  reason: AuthorizationReason;
}

export function authorize(
  resourceInput: ResourceRef,
  action: Action,
  contextInput: RequestContext,
): AuthorizationDecision {
  const resource = ResourceRefSchema.parse(resourceInput);
  const context = RequestContextSchema.parse(contextInput);
  if (context.actor.type !== 'user') {
    return { allowed: false, reason: 'denied_unauthenticated_actor' };
  }
  if (resource.organizationId !== context.organizationId) {
    return { allowed: false, reason: 'denied_tenant_mismatch' };
  }
  if (resource.archivedAt && action !== 'resource:read') {
    return { allowed: false, reason: 'denied_archived_resource' };
  }
  if (resource.ownerId === context.actor.id) {
    return { allowed: true, reason: 'allowed_owner' };
  }
  if (resource.visibility === 'private') {
    return { allowed: false, reason: 'denied_private_resource' };
  }

  const memberships = context.memberships.filter(
    (membership) =>
      membership.active &&
      membership.userId === context.actor.id &&
      membership.organizationId === context.organizationId,
  );
  const workspaceMemberships = memberships.filter(
    (membership) =>
      membership.workspaceId === null ||
      membership.workspaceId === resource.workspaceId,
  );
  if (resource.workspaceId && workspaceMemberships.length === 0) {
    return { allowed: false, reason: 'denied_workspace_mismatch' };
  }

  const hasRole = (roles: Role[]) =>
    workspaceMemberships.some((membership) => roles.includes(membership.role));
  if (action === 'resource:read' && hasRole(['admin', 'member', 'viewer'])) {
    return { allowed: true, reason: 'allowed_membership' };
  }
  if (
    ['resource:write', 'resource:share', 'resource:delete'].includes(action) &&
    hasRole(['admin'])
  ) {
    return { allowed: true, reason: 'allowed_membership' };
  }

  return { allowed: false, reason: 'denied_role' };
}

export function authorizeExecution(
  resourceInput: ResourceRef,
  action: Action,
  contextInput: ExecutionContext,
  now = new Date(),
): AuthorizationDecision {
  const resource = ResourceRefSchema.parse(resourceInput);
  const context = ExecutionContextSchema.parse(contextInput);
  const policy = context.policySnapshot;
  if (
    context.organizationId !== policy.organizationId ||
    policy.organizationId !== resource.organizationId
  ) {
    return { allowed: false, reason: 'denied_tenant_mismatch' };
  }
  if (
    context.workspaceId !== null &&
    resource.workspaceId !== context.workspaceId
  ) {
    return { allowed: false, reason: 'denied_workspace_mismatch' };
  }
  if (Date.parse(policy.expiresAt) <= now.getTime()) {
    return { allowed: false, reason: 'denied_role' };
  }
  if (
    resource.visibility === 'private' &&
    resource.ownerId !== policy.subjectId
  ) {
    return { allowed: false, reason: 'denied_private_resource' };
  }
  const grant = policy.grants.some(
    (candidate) =>
      candidate.action === action &&
      candidate.resourceType === resource.type &&
      (candidate.workspaceId === null ||
        candidate.workspaceId === resource.workspaceId),
  );
  return grant
    ? { allowed: true, reason: 'allowed_explicit_grant' }
    : { allowed: false, reason: 'denied_role' };
}
