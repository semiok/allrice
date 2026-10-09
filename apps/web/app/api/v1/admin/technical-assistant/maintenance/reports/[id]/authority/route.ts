import { getMaintenanceReportAuthority } from '@allrice/database';
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
