import { readAdminJson } from '../../../../../../../../lib/tenant-administration/http';
import { UuidSchema } from '@allrice/contracts';
import {
  rotateMaintenanceCredential,
  MaintenanceConflict,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../../../lib/identity/platform-admin';
import { sameOriginBrowserWrite } from '../../../../../../../../lib/identity/request-origin';
import { executionErrorResponse } from '../../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
export async function PUT(
  request: Request,
  input: { params: Promise<{ id: string }> },
) {
  try {
    if (!sameOriginBrowserWrite(request))
      return new Response(null, { status: 403, headers });
    if (
      !(
        request.headers.get('content-type')?.split(';')[0] ===
        'application/json'
      )
    )
      return new Response(null, { status: 415, headers });
    const context = await requirePlatformAdminContext(request);
    const body = await readAdminJson(request, 1000);
    return Response.json(
      await rotateMaintenanceCredential(
        context,
        UuidSchema.parse((await input.params).id),
        body,
      ),
      { headers },
    );
  } catch (error) {
    if (error instanceof MaintenanceConflict)
      return Response.json(
        { error: 'maintenance_configuration_conflict' },
        { status: 409, headers },
      );
    return executionErrorResponse(error);
  }
}
