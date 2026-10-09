import type { RequestContext } from '@allrice/contracts';

/** Identity projection for already authorized server work. This type confers
 * no browser authentication or resource authority by itself. */
export type ResourcePrincipal = Pick<
  RequestContext,
  'requestId' | 'actor' | 'organizationId' | 'workspaceId' | 'memberships'
>;
