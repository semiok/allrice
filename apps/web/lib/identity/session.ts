import { cookies } from 'next/headers';

import { authenticateSession, DataAccessError } from '@allrice/database';

import { portalAuthEnabled, resolvePortal } from '../portal/config';
import {
  portalSessionCookieName,
  verifyPortalSession,
} from '../portal/session';

export const sessionCookieName = 'allrice_session';

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure:
    process.env.NODE_ENV === 'production' &&
    process.env.ALLRICE_PORTAL_SECURE_COOKIE !== '0',
  path: '/',
};

export async function getRequestContext(request: Request) {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  if (!token) return null;
  if (portalAuthEnabled()) {
    const portal = resolvePortal(request.headers.get('host'));
    if (!portal) return null;
    const portalSession = verifyPortalSession(
      cookieStore.get(portalSessionCookieName)?.value,
      portal,
    );
    if (!portalSession) return null;
    return authenticateSession(token, {
      organizationId: portalSession.organizationId,
      workspaceId: portalSession.workspaceId,
    });
  }
  return authenticateSession(token, {
    organizationId:
      request.headers.get('x-allrice-organization-id') ?? undefined,
    workspaceId: request.headers.get('x-allrice-workspace-id') ?? undefined,
  });
}

/**
 * Require an authenticated tenant context while preserving the exact context
 * resolution rules used by getRequestContext.
 */
export async function requireRequestContext(request: Request) {
  const context = await getRequestContext(request);
  if (!context) throw new DataAccessError('authentication_required');
  return context;
}
