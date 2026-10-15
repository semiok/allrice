import { platformEmployeeHistoryHttp } from '../../../../../../../../lib/employee-administration/history-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ employeeId: string; revisionId: string }> },
) {
  const params = await context.params;
  return platformEmployeeHistoryHttp(
    request,
    params.employeeId,
    params.revisionId,
  );
}
