import { organizationAssignmentsHttp } from '../../../../../../../lib/organization-administration/assignments-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  route: { params: Promise<{ organizationId: string }> },
) {
  return organizationAssignmentsHttp(
    request,
    (await route.params).organizationId,
  );
}
export const POST = GET;
