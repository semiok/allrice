import { cookies } from 'next/headers';

import { revokeSession } from '@allrice/database';

import {
  sessionCookieName,
  sessionCookieOptions,
} from '../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST() {
  const cookieStore = await cookies();
  const token = cookieStore.get(sessionCookieName)?.value;
  if (token) await revokeSession(token);
  cookieStore.set(sessionCookieName, '', {
    ...sessionCookieOptions,
    expires: new Date(0),
  });
  return new Response(null, { status: 204 });
}
