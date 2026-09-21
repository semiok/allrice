import { tenantResourcesHttp } from '../../../../../../../lib/tenant-administration/resources-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, route: Route) {
  return tenantResourcesHttp(
    request,
    (await route.params).organizationId,
    'mcp',
  );
}
export async function POST(request: Request, route: Route) {
  return tenantResourcesHttp(
    request,
    (await route.params).organizationId,
    'mcp',
  );
}
export async function PATCH(request: Request, route: Route) {
  return tenantResourcesHttp(
    request,
    (await route.params).organizationId,
    'mcp',
  );
}
