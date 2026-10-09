import { getMaintenanceReport } from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../../../lib/identity/platform-admin';
import {
  maintenanceErrorResponse,
  maintenanceHttpHeaders,
} from '../../../../../../../../lib/maintenance/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return Response.json(
      await getMaintenanceReport(
        await requirePlatformAdminContext(request),
        (await context.params).id,
      ),
      { headers: maintenanceHttpHeaders },
    );
  } catch (e) {
    return maintenanceErrorResponse(e);
  }
}
