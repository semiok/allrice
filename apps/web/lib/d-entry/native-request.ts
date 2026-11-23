import { cookies } from 'next/headers';
import type { DEntrySelectionInput, RequestContext } from '@allrice/contracts';
import { DataAccessError } from '@allrice/database';
import { requireRequestContext, sessionCookieName } from '../identity/session';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { resolveDEntryIdentity } from './identity';

export async function authenticateNativeRequest(request: Request) {
  if (!sameOriginBrowserWrite(request))
    throw new DataAccessError('authorization_denied');
  return requireRequestContext(request);
}

export async function currentNativeRequest(
  request: Request,
  selection: DEntrySelectionInput,
  context: RequestContext,
) {
  const identity = await resolveDEntryIdentity(context, selection, 'execute');
  const token = (await cookies()).get(sessionCookieName)?.value;
  if (!token) throw new DataAccessError('authentication_required');
  return { context, identity, token, selection, signal: request.signal };
}
