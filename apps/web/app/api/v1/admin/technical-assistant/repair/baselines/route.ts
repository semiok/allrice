import { getPlatformRepairCatalog } from '@allrice/database';
import { RepositoryCatalogSchema } from '@allrice/database/technical-contracts';
import { requirePlatformAdminContext } from '../../../../../../../lib/identity/platform-admin';
import { executionErrorResponse } from '../../../../../../../lib/execution/responses';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    return Response.json(
      RepositoryCatalogSchema.parse(
        await getPlatformRepairCatalog(
          await requirePlatformAdminContext(request),
        ),
      ),
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
