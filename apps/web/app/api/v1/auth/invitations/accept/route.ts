import { cookies } from 'next/headers';

import { acceptInvitation, createSession } from '@allrice/database';

import {
  sessionCookieName,
  sessionCookieOptions,
} from '../../../../../../lib/identity/session';
import { identityErrorResponse } from '../../../../../../lib/identity/responses';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const user = await acceptInvitation(await request.json());
    const session = await createSession(user.id);
    (await cookies()).set(sessionCookieName, session.token, {
      ...sessionCookieOptions,
      expires: new Date(session.expiresAt),
    });
    return Response.json({ user }, { status: 201 });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
