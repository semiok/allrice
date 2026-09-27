import {
  listDshRuntimeInventory,
  readOperationsInventory,
  listTenantRuntimeInventory,
} from '@allrice/database';

import { executionErrorResponse } from '../../../../../lib/execution/responses';
import { requirePlatformAdminContext } from '../../../../../lib/identity/platform-admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requirePlatformAdminContext(request);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
    const limit = Number.isFinite(requestedLimit) ? requestedLimit : 100;
    const scope = {
      organizationId: url.searchParams.get('organizationId') ?? undefined,
      ownerId: url.searchParams.get('ownerId') ?? undefined,
    };
    const [tenants, runtimes, employeeTenants, operations] = await Promise.all([
      listTenantRuntimeInventory(),
      listDshRuntimeInventory(limit, scope),
      scope.organizationId && scope.ownerId
        ? listTenantRuntimeInventory(scope)
        : Promise.resolve([]),
      readOperationsInventory().catch(() => null),
    ]);
    return Response.json(
      {
        console: {
          name: 'AllRice Runtime Console',
          authority: 'ChatFlow 3.0',
          harness: 'DSH',
          mode: 'read-only',
          source: 'allrice_conversation_runtimes',
        },
        tenants,
        runtimes,
        employeeTenants,
        operations,
        scope,
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    return executionErrorResponse(error);
  }
}
