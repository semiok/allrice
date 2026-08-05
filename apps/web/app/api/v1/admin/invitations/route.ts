import { createInvitation, IdentityError } from '@allrice/database';

import { identityErrorResponse } from '../../../../../lib/identity/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) {
      return identityErrorResponse(new IdentityError('authentication_failed'));
    }
    const invitation = await createInvitation(context, await request.json());
    return Response.json({ invitation }, { status: 201 });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
