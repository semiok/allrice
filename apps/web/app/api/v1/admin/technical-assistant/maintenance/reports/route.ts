import { listMaintenanceReports } from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import {
  maintenanceErrorResponse,
  maintenanceHttpHeaders,
} from '../../../../../../../lib/maintenance/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    return Response.json(
      await listMaintenanceReports(await requirePlatformAdminContext(request), {
        deploymentId: query.get('deploymentId') ?? undefined,
        cursor: query.get('cursor') ?? undefined,
      }),
      { headers: maintenanceHttpHeaders },
    );
  } catch (e) {
    return maintenanceErrorResponse(e);
  }
}
