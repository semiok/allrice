import { organizationAdministrationHttp } from '../../../../../../../../../lib/organization-administration/http';
export const runtime = 'nodejs';
export async function POST(
  request: Request,
  route: { params: Promise<{ organizationId: string; userId: string }> },
) {
  const { organizationId, userId } = await route.params;
  return organizationAdministrationHttp(
    request,
    organizationId,
    userId,
    'status',
  );
}
