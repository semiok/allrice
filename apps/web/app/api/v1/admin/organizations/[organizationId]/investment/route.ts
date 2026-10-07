import { investmentHttp } from '../../../../../../../lib/organization-administration/investment-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  return investmentHttp(request, (await params).organizationId);
}
export const POST = GET;
