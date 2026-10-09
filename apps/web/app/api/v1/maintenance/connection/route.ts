import { getMaintenanceConnection } from '@allrice/database';
import {
  maintenanceInstallation,
  maintenanceErrorResponse,
  maintenanceHttpHeaders,
} from '../../../../../lib/maintenance/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return Response.json(
      await getMaintenanceConnection(maintenanceInstallation(request)),
      { headers: maintenanceHttpHeaders },
    );
  } catch (e) {
    return maintenanceErrorResponse(e);
  }
}
