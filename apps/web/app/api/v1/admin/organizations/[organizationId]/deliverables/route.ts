import { companyDeliverablesHttp } from '../../../../../../../lib/organization-administration/deliverables-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  return companyDeliverablesHttp(request, (await params).organizationId);
}
