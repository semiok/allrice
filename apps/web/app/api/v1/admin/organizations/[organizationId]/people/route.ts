import { organizationAdministrationHttp } from '../../../../../../../lib/organization-administration/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  route: { params: Promise<{ organizationId: string }> },
) {
  return organizationAdministrationHttp(
    request,
    (await route.params).organizationId,
    undefined,
    'people',
  );
}
export const POST = GET;
