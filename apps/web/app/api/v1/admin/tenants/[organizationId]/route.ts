import { tenantAdministrationHttp } from '../../../../../../lib/tenant-administration/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  route: { params: Promise<{ organizationId: string }> },
) {
  return tenantAdministrationHttp(request, (await route.params).organizationId);
}
