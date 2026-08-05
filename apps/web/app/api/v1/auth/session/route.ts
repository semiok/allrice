import { identityErrorResponse } from '../../../../../lib/identity/responses';
import { getRequestContext } from '../../../../../lib/identity/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const context = await getRequestContext(request);
    if (!context) {
      return Response.json(
        {
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'Authentication required',
            requestId: crypto.randomUUID(),
            retryable: false,
          },
        },
        { status: 401 },
      );
    }
    return Response.json({ context });
  } catch (error) {
    return identityErrorResponse(error);
  }
}
