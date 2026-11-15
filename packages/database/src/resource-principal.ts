import type { RequestContext } from '@allrice/contracts';

/** Identity projection for already authorized server work. This type confers
 * no browser authentication or resource authority by itself. */
export type ResourcePrincipal = Pick<
  RequestContext,
  'requestId' | 'actor' | 'organizationId' | 'workspaceId' | 'memberships'
>;

/** Already-authorized server work may carry a device/chat ID as sessionId.
 * Project only this port's identity, so it cannot be mistaken for a Web login.
 * Browser callers retain their real RequestContext and current session checks. */
export function resourcePrincipal({
  requestId,
  actor,
  organizationId,
  workspaceId,
  memberships,
}: ResourcePrincipal): ResourcePrincipal {
  return { requestId, actor, organizationId, workspaceId, memberships };
}
