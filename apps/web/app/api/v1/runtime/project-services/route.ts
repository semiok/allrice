import {
  ProjectServiceUserActionSchema,
  UuidSchema,
  projectPreviewHost,
} from '@allrice/contracts';
import {
  projectServiceUserAction,
  readProjectService,
  createProjectPreviewAccess,
  localServiceFeatureEnabled,
  RuntimePolicyError,
} from '@allrice/database';
import { getRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
async function handle(request: Request, write: boolean) {
  if (!localServiceFeatureEnabled())
    return new Response(null, { status: 404, headers });
  try {
    if (write && !sameOriginBrowserWrite(request))
      return new Response(null, { status: 403, headers });
    const context = await getRequestContext(request);
    if (!context) return new Response(null, { status: 401, headers });
    const url = new URL(request.url),
      id = UuidSchema.parse(url.searchParams.get('serviceId')),
      workspaceId = UuidSchema.parse(
        url.searchParams.get('workspaceId') ?? context.workspaceId,
      ),
      principal = { ...context, workspaceId };
    if (!write)
      return Response.json(
        { service: await readProjectService(principal, id) },
        { headers },
      );
    let text = '',
      size = 0;
    const reader = request.body?.getReader();
    if (reader)
      try {
        const decoder = new TextDecoder();
        for (;;) {
          const p = await reader.read();
          if (p.done) break;
          size += p.value.length;
          if (size > 2048) {
            await reader.cancel();
            return new Response(null, { status: 413, headers });
          }
          text += decoder.decode(p.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    const action = ProjectServiceUserActionSchema.parse(JSON.parse(text));
    const service = await projectServiceUserAction(principal, id, action);
    if (action.action === 'preview') {
      const suffix = process.env.ALLRICE_PROJECT_PREVIEW_SUFFIX;
      if (!suffix) throw Error('PROJECT_PREVIEW_GATEWAY_UNAVAILABLE');
      const token = await createProjectPreviewAccess(principal, id);
      return Response.json(
        {
          service,
          previewUrl: `https://${projectPreviewHost(id, suffix)}/?_allrice_preview_ticket=${token}`,
        },
        { headers },
      );
    }
    return Response.json({ service }, { headers });
  } catch (error) {
    return Response.json(
      {
        code:
          error instanceof RuntimePolicyError
            ? error.code
            : 'PROJECT_SERVICE_UNAVAILABLE',
      },
      {
        status: error instanceof Error && error.name === 'ZodError' ? 400 : 403,
        headers,
      },
    );
  }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
