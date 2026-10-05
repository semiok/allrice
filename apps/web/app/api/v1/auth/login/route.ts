import { cookies } from 'next/headers';

import {
  ensureBootstrapPortalPrincipal,
  getLegacyPortalAccount,
  getPlatformPortalAccount,
  initializeAccountLogin,
  isPlatformAdmin,
  login,
} from '@allrice/database';

import {
  sessionCookieName,
  sessionCookieOptions,
} from '../../../../../lib/identity/session';
import {
  apiProblem,
  authenticationRequiredProblem,
} from '../../../../../lib/api-error-response';
import { identityErrorResponse } from '../../../../../lib/identity/responses';
import {
  portalAuthEnabled,
  isUnifiedPortalHost,
  resolvePortal,
  portalAccountKind,
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
    const accountKind = portalAccountKind(request.headers.get('host'));
    if (
      portalAuthEnabled() &&
      !isUnifiedPortalHost(request.headers.get('host'))
    ) {
      const portal = resolvePortal(request.headers.get('host'));
      if (!portal)
        return apiProblem({
          status: 421,
          code: 'AUTHORIZATION_DENIED',
          message: 'Unknown AllRice portal host',
          retryable: false,
        });
      const input = (await request.json()) as {
        username?: unknown;
        password?: unknown;
      };
      const readAccount = () =>
        portal.kind === 'platform_admin'
          ? getPlatformPortalAccount(portal.principal)
          : getLegacyPortalAccount(portal.principal);
      let account = await readAccount();
      if (!account?.username) {
        if (!verifyPortalCredentials(portal, input.username, input.password))
          return authenticationRequiredProblem('Authentication failed');
        const principal = await ensureBootstrapPortalPrincipal(
          portal.principal,
        );
        await initializeAccountLogin({
          userId: principal.user.id,
          username: portal.username,
          password: String(input.password),
        });
        account = await readAccount();
      }
      if (!account)
        return authenticationRequiredProblem('Authentication failed');
      const result = await login(input, portal.principal.email, accountKind);
      const databaseSession = result.session;
      const portalSession = createPortalSession({
        portal,
        subject: result.user.id,
        organizationId: account.organization_id,
        workspaceId: account.workspace_id,
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
        user: result.user,
        portal: { key: portal.key, kind: portal.kind },
        homePath: portal.homePath,
      });
    }
    const result = await login(await request.json(), undefined, accountKind);
    (await cookies()).set(sessionCookieName, result.session.token, {
      ...sessionCookieOptions,
      expires: new Date(result.session.expiresAt),
    });
    const admin = await isPlatformAdmin({
      actor: { type: 'user', id: result.user.id },
    });
    return Response.json({
      user: result.user,
      homePath: admin ? '/runtime-console' : '/chatflow',
    });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
