import { tenantEmployeesHttp } from '../../../../../../../lib/tenant-administration/tenant-employees-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, route: Route) {
  return tenantEmployeesHttp(request, (await route.params).organizationId);
}
export async function POST(request: Request, route: Route) {
  return tenantEmployeesHttp(request, (await route.params).organizationId);
}
