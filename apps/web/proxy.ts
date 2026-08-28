import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { portalAuthEnabled, resolvePortal } from './lib/portal/config';
import {
  portalSessionCookieName,
  verifyPortalSession,
} from './lib/portal/session';

const publicPaths = new Set([
  '/login',
  '/api/v1/auth/login',
  '/api/health/live',
  '/api/health/ready',
]);

const bridgeDevicePaths = new Set([
  '/api/v1/bridge/device/pair',
  '/api/v1/bridge/device/heartbeat',
  '/api/v1/bridge/device/status',
  '/api/v1/bridge/device/grants',
  '/api/v1/bridge/device/commands/next',
  '/api/v1/bridge/device/workspace-selections/next',
  '/api/v1/bridge/device/revoke',
]);

export function isBridgeDeviceApiPath(pathname: string) {
  return (
    bridgeDevicePaths.has(pathname) ||
    /^\/api\/v1\/bridge\/device\/commands\/[^/]+\/complete$/.test(pathname) ||
    /^\/api\/v1\/bridge\/device\/workspace-selections\/[^/]+\/complete$/.test(
      pathname,
    )
  );
}

export function proxy(request: NextRequest) {
  if (!portalAuthEnabled()) return NextResponse.next();

  const portal = resolvePortal(request.headers.get('host'));
  if (!portal) {
    return new NextResponse('Unknown AllRice portal host', { status: 421 });
  }

  if (
    publicPaths.has(request.nextUrl.pathname) ||
    isBridgeDeviceApiPath(request.nextUrl.pathname)
  ) {
    return NextResponse.next();
  }

  const session = verifyPortalSession(
    request.cookies.get(portalSessionCookieName)?.value,
    portal,
  );
  if (session) {
    const tenantForbidden =
      portal.kind === 'tenant' &&
      (request.nextUrl.pathname.startsWith('/api/v1/admin') ||
        request.nextUrl.pathname.startsWith('/chatflow/admin') ||
        request.nextUrl.pathname.startsWith('/chatflow/employees') ||
        request.nextUrl.pathname.startsWith('/employees') ||
        request.nextUrl.pathname.startsWith('/skillhub'));
    if (tenantForbidden) {
      if (request.nextUrl.pathname.startsWith('/api/')) {
        return Response.json(
          { error: 'authorization_denied' },
          { status: 403 },
        );
      }
      return NextResponse.redirect(new URL(portal.homePath, request.url));
    }
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return Response.json({ error: 'authentication_required' }, { status: 401 });
  }
  const login = new URL('/login', request.url);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
