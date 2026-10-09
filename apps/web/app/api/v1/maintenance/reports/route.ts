import {
  receiveMaintenanceReport,
  readMaintenanceInstallationReceipt,
} from '@allrice/database';
import { readAdminJson } from '../../../../../lib/tenant-administration/http';
import {
  maintenanceInstallation,
  maintenanceErrorResponse,
  maintenanceHttpHeaders,
} from '../../../../../lib/maintenance/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try {
    if (
      request.headers.get('content-type')?.split(';')[0] !== 'application/json'
    )
      return new Response(null, {
        status: 415,
        headers: maintenanceHttpHeaders,
      });
    return Response.json(
      await receiveMaintenanceReport(
        maintenanceInstallation(request),
        await readAdminJson(request, 16000),
        request.headers.get('x-allrice-sent-at') ?? '',
      ),
      { headers: maintenanceHttpHeaders },
    );
  } catch (e) {
    return maintenanceErrorResponse(e);
  }
}
export async function GET(request: Request) {
  try {
    return Response.json(
      await readMaintenanceInstallationReceipt(
        maintenanceInstallation(request),
        new URL(request.url).searchParams.get('sourceReportId') ?? '',
      ),
      { headers: maintenanceHttpHeaders },
    );
  } catch (e) {
    return maintenanceErrorResponse(e);
  }
}
