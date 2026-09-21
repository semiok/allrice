import { tenantPolicyHttp } from '../../../../../../../lib/tenant-administration/policy-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Route = { params: Promise<{ organizationId: string }> };
export async function GET(request: Request, route: Route) {
  return tenantPolicyHttp(request, (await route.params).organizationId);
}
export async function PUT(request: Request, route: Route) {
  return tenantPolicyHttp(request, (await route.params).organizationId);
}
