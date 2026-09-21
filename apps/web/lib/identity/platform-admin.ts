import { DataAccessError, isPlatformAdmin } from '@allrice/database';

import { getRequestContext } from './session';

export async function requirePlatformAdminContext(request: Request) {
  const context = await getRequestContext(request);
  if (!context || context.actor.type !== 'user') {
    throw new DataAccessError('authentication_required');
  }
  const platformAdmin = await isPlatformAdmin(context);
  if (!platformAdmin) throw new DataAccessError('authorization_denied');
  return context;
}
