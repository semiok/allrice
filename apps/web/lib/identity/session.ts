import { cookies } from 'next/headers';

import { authenticateSession } from '@allrice/database';

export const sessionCookieName = 'allrice_session';

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: process.env.NODE_ENV === 'production',
  path: '/',
};

export async function getRequestContext(request: Request) {
  const token = (await cookies()).get(sessionCookieName)?.value;
  if (!token) return null;
  return authenticateSession(token, {
    organizationId:
      request.headers.get('x-allrice-organization-id') ?? undefined,
    workspaceId: request.headers.get('x-allrice-workspace-id') ?? undefined,
  });
}
