import {
  DataAccessError,
  reviewSubscriptionUsageBudgetForAdmin,
} from '@allrice/database';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
import { getRequestContext } from '../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    if (!sameOriginBrowserWrite(request))
      throw new DataAccessError('authorization_denied');
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    return Response.json({
      review: await reviewSubscriptionUsageBudgetForAdmin({
        context,
        review: await request.json(),
      }),
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
