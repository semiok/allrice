import { CreateMaintenanceGrantSchema } from '@allrice/database/technical-contracts';
import { sameOriginBrowserWrite } from '../../../../../../../../../lib/identity/request-origin';
import { readAdminJson } from '../../../../../../../../../lib/tenant-administration/http';
import {
  authorizeMaintenanceReport,
  getMaintenanceReportAuthority,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../../../../lib/identity/platform-admin';
import {
  maintenanceErrorResponse,
  maintenanceHttpHeaders,
} from '../../../../../../../../../lib/maintenance/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await getMaintenanceReportAuthority(
        await requirePlatformAdminContext(request),
        (await context.params).id,
      ),
      { headers: maintenanceHttpHeaders },
    );
  } catch (error) {
    return maintenanceErrorResponse(error);
  }
}

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
      body = CreateMaintenanceGrantSchema.parse(
        await readAdminJson(request, 2000),
      );
    if (body.reportId !== (await route.params).id)
      return new Response(null, {
        status: 400,
        headers: maintenanceHttpHeaders,
      });
    return Response.json(await authorizeMaintenanceReport(context, body), {
      headers: maintenanceHttpHeaders,
    });
  } catch (error) {
    return maintenanceErrorResponse(error);
  }
}
