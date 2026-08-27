import { cookies } from 'next/headers';

import {
  createSession,
  ensureBootstrapPortalPrincipal,
  login,
} from '@allrice/database';

import {
  sessionCookieName,
  sessionCookieOptions,
} from '../../../../../lib/identity/session';
import { identityErrorResponse } from '../../../../../lib/identity/responses';
import {
  portalAuthEnabled,
  resolvePortal,
} from '../../../../../lib/portal/config';
import {
  createPortalSession,
  portalSessionCookieName,
  portalSessionCookieOptions,
  verifyPortalCredentials,
} from '../../../../../lib/portal/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    if (portalAuthEnabled()) {
      const portal = resolvePortal(request.headers.get('host'));
      if (!portal)
        return Response.json({ error: 'unknown_portal' }, { status: 421 });
      const input = (await request.json()) as {
        username?: unknown;
        password?: unknown;
      };
      if (!verifyPortalCredentials(portal, input.username, input.password)) {
        return Response.json(
          { error: 'authentication_failed' },
          { status: 401 },
        );
      }
      const principal = await ensureBootstrapPortalPrincipal(portal.principal);
      const databaseSession = await createSession(principal.user.id);
      const portalSession = createPortalSession({
        portal,
        subject: principal.user.id,
        organizationId: principal.organizationId,
        workspaceId: principal.workspaceId,
      });
      const cookieStore = await cookies();
      cookieStore.set(sessionCookieName, databaseSession.token, {
        ...sessionCookieOptions,
        sameSite: 'lax',
        expires: new Date(databaseSession.expiresAt),
      });
      cookieStore.set(portalSessionCookieName, portalSession.value, {
        ...portalSessionCookieOptions,
        expires: portalSession.expiresAt,
      });
      return Response.json({
        user: principal.user,
        portal: { key: portal.key, kind: portal.kind },
        homePath: portal.homePath,
      });
    }
    const result = await login(await request.json());
    (await cookies()).set(sessionCookieName, result.session.token, {
      ...sessionCookieOptions,
      expires: new Date(result.session.expiresAt),
    });
    return Response.json({ user: result.user });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
