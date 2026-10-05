import { projectPreviewHost } from '@allrice/contracts';
import {
  platformQualityServiceContext,
  readProjectService,
  projectServiceUserAction,
  createProjectPreviewAccess,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    const binding = await platformQualityServiceContext(
      await requirePlatformAdminContext(request),
      (await params).id,
    );
    return Response.json(
      { service: await readProjectService(binding.context, binding.serviceId) },
      { headers },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
export async function POST(request: Request, { params }: Context) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403, headers });
    const binding = await platformQualityServiceContext(
      await requirePlatformAdminContext(request),
      (await params).id,
    );
    const text = await request.text();
    if (text.length > 2048) return new Response(null, { status: 413, headers });
    const action = JSON.parse(text);
    const service = await projectServiceUserAction(
      binding.context,
      binding.serviceId,
      action,
    );
    if (action.action === 'preview') {
      const suffix = process.env.ALLRICE_PROJECT_PREVIEW_SUFFIX;
      if (!suffix) throw Error('QUALITY_PREVIEW_GATEWAY_UNAVAILABLE');
      const token = await createProjectPreviewAccess(
        binding.context,
        binding.serviceId,
      );
      return Response.json(
        {
          service,
          previewUrl: `https://${projectPreviewHost(binding.serviceId, suffix)}/?_allrice_preview_ticket=${token}`,
        },
        { headers },
      );
    }
    return Response.json({ service }, { headers });
  } catch (error) {
    return executionErrorResponse(error);
  }
}
