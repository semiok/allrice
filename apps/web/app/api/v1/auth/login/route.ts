import { cookies } from 'next/headers';

import { login } from '@allrice/database';

import {
  sessionCookieName,
  sessionCookieOptions,
} from '../../../../../lib/identity/session';
import { identityErrorResponse } from '../../../../../lib/identity/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
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
