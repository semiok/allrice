import { UuidSchema } from '@allrice/contracts';
import {
  ArtifactReviewError,
  listMessageFeedback,
  mutateMessageFeedback,
} from '@allrice/database';
import { requireRequestContext } from '../../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
type Route = { params: Promise<{ id: string }> };
async function handle(
  request: Request,
  route: Route,
  action: 'list' | 'put' | 'delete',
) {
  try {
    if (action !== 'list' && !sameOriginBrowserWrite(request))
      return new Response(null, { status: 403 });
    const login = await requireRequestContext(request);
    const workspaceId = UuidSchema.parse(
      new URL(request.url).searchParams.get('workspaceId'),
    );
    const context = { ...login, workspaceId },
      { id } = await route.params;
    if (action === 'list')
      return Response.json(
        { ok: true, value: await listMessageFeedback(context, id) },
        { headers },
      );
    const text = await request.text();
    if (text.length > 20000) return new Response(null, { status: 413 });
    return Response.json(
      await mutateMessageFeedback(context, id, action, JSON.parse(text)),
      { headers },
    );
  } catch (error) {
    if (error instanceof ArtifactReviewError)
      return Response.json(
        { error: { code: error.code, message: '无法访问这条反馈' } },
        { status: 404, headers },
      );
    return executionErrorResponse(error);
  }
}
export const GET = (request: Request, route: Route) =>
  handle(request, route, 'list');
export const PUT = (request: Request, route: Route) =>
  handle(request, route, 'put');
export const DELETE = (request: Request, route: Route) =>
  handle(request, route, 'delete');
