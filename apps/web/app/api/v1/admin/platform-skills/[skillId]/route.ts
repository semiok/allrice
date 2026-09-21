import { employeeAdministrationHttp } from '../../../../../../lib/tenant-administration/employee-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  route: { params: Promise<{ skillId: string }> },
) {
  return employeeAdministrationHttp(
    request,
    (await route.params).skillId,
    'skill',
  );
}
