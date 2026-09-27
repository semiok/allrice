import { organizationAdministrationHttp } from '../../../../../../lib/organization-administration/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function PATCH(
  request: Request,
  route: { params: Promise<{ organizationId: string }> },
) {
  return organizationAdministrationHttp(
    request,
    (await route.params).organizationId,
  );
}
export const GET = PATCH;
