import { organizationAdministrationHttp } from '../../../../../../../../lib/organization-administration/http';
export const runtime = 'nodejs';
export async function PATCH(
  request: Request,
  route: { params: Promise<{ organizationId: string; departmentId: string }> },
) {
  const { organizationId, departmentId } = await route.params;
  return organizationAdministrationHttp(
    request,
    organizationId,
    departmentId,
    'departments',
  );
}
