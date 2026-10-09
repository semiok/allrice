import { z } from 'zod';
import { controlMaintenanceGrant } from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../../../lib/identity/request-origin';
import { readAdminJson } from '../../../../../../../../lib/tenant-administration/http';
import {
  maintenanceErrorResponse,
  maintenanceHttpHeaders,
} from '../../../../../../../../lib/maintenance/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, {
        status: 403,
        headers: maintenanceHttpHeaders,
      });
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return new Response(null, {
        status: 415,
        headers: maintenanceHttpHeaders,
      });
    const context = await requirePlatformAdminContext(request),
      body = z
        .object({ action: z.enum(['revoke', 'inspect']) })
        .strict()
        .parse(await readAdminJson(request, 200));
    return Response.json(
      await controlMaintenanceGrant(
        context,
        (await route.params).id,
        body.action,
      ),
      { headers: maintenanceHttpHeaders },
    );
  } catch (error) {
    return maintenanceErrorResponse(error);
  }
}
