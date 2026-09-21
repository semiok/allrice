import { employeeAdministrationHttp } from '../../../../../../../lib/tenant-administration/employee-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  route: { params: Promise<{ employeeId: string }> },
) {
  return employeeAdministrationHttp(
    request,
    (await route.params).employeeId,
    'review',
  );
}
