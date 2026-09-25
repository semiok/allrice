import { getTenantFeedback, reviewTenantFeedback } from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
type Route = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'private, no-store' };
export async function GET(request: Request, route: Route) {
  try {
    const context = await requirePlatformAdminContext(request);
    return Response.json(
      { feedback: await getTenantFeedback(context, (await route.params).id) },
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function PATCH(request: Request, route: Route) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403 });
    const context = await requirePlatformAdminContext(request);
    const text = await request.text();
    if (text.length > 20000) return new Response(null, { status: 413 });
    const result = await reviewTenantFeedback(
      context,
      (await route.params).id,
      JSON.parse(text),
    );
    return Response.json(result, {
      status: result.updated ? 200 : 409,
      headers,
    });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
