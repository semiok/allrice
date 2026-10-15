import { platformEmployeeHistoryHttp } from '../../../../../../../lib/employee-administration/history-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ employeeId: string }> },
) {
  return platformEmployeeHistoryHttp(
    request,
    (await context.params).employeeId,
  );
}
