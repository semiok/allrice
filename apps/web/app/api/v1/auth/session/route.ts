import { authenticationRequiredProblem } from '../../../../../lib/api-error-response';
import { identityErrorResponse } from '../../../../../lib/identity/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) {
      return authenticationRequiredProblem();
    }
    return Response.json({ context });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
