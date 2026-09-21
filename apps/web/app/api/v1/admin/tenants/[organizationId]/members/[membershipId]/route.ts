import { tenantAdministrationHttp } from '../../../../../../../../lib/tenant-administration/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(
  request: Request,
  route: { params: Promise<{ organizationId: string; membershipId: string }> },
) {
  const { organizationId, membershipId } = await route.params;
  return tenantAdministrationHttp(request, organizationId, membershipId);
}
