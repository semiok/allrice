import { DataAccessError } from '@allrice/database';

import { getRequestContext } from './session';

export async function requirePlatformAdminContext(request: Request) {
  const context = await getRequestContext(request);
  if (!context || context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  const platformAdmin = context.memberships.some(
    (membership) =>
      membership.active &&
      membership.userId === context.actor.id &&
      membership.organizationId === context.organizationId &&
      membership.role === 'admin',
  );
  if (!platformAdmin) throw new DataAccessError('authorization_denied');
  return context;
}
