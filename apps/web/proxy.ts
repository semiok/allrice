import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  authenticationRequiredProblem,
  authorizationDeniedProblem,
} from './lib/api-problem';
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
  '/api/v1/bridge/device/runtime-profile',
  '/api/v1/bridge/device/operations/next',
  '/api/v1/bridge/browser-workspaces',
  '/api/v1/bridge/browser-workspaces/capture',
]);

export function isBridgeDeviceApiPath(pathname: string) {
  return (
    bridgeDevicePaths.has(pathname) ||
    /^\/api\/v1\/bridge\/device\/operations\/[0-9a-f-]{36}\/(start|heartbeat|output|receipts|service)$/.test(
      pathname,
    ) ||
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
    // This exact read-only endpoint authenticates its own scoped sync token.
    request.nextUrl.pathname === '/api/v1/internal/runtime-capabilities' ||
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
    // This exact endpoint is tenant-admin management, not platform control.
    // The handler still requires a current DB-backed tenant admin membership.
    const tenantManagement = [
      '/api/v1/admin/mcp',
      '/api/v1/admin/local-mcp',
      '/api/v1/admin/browser-control',
      '/api/v1/admin/local-browser',
    ].includes(request.nextUrl.pathname);
    const tenantForbidden =
      portal.kind === 'tenant' &&
      ((request.nextUrl.pathname.startsWith('/api/v1/admin') &&
        !tenantManagement) ||
        request.nextUrl.pathname.startsWith('/chatflow/employees') ||
        request.nextUrl.pathname.startsWith('/employees'));
    if (tenantForbidden) {
      if (request.nextUrl.pathname.startsWith('/api/')) {
        return authorizationDeniedProblem();
      }
      return NextResponse.redirect(new URL(portal.homePath, request.url));
    }
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return authenticationRequiredProblem();
  }
  const login = new URL('/login', request.url);
  if (
    request.nextUrl.pathname === '/chatflow' &&
    request.nextUrl.searchParams.has('employee')
  ) {
    login.searchParams.set(
      'next',
      request.nextUrl.pathname + request.nextUrl.search,
    );
  }
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
