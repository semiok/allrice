import {
  listPlatformNativeSkills,
  listEmployeeToolAvailability,
  readRuntimeCapabilityInventory,
} from '@allrice/database';
import { requirePlatformAdminContext } from '../../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../../lib/execution/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
    const [inventory, skills] = await Promise.all([
      readRuntimeCapabilityInventory(),
      listPlatformNativeSkills(),
    ]);
    return Response.json(
      {
        ...inventory,
        skills,
        webTools: listEmployeeToolAvailability().map((tool) => ({
          name: tool.canonicalName,
          enabled: tool.released,
        })),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
