import { companyAssetsHttp } from '../../../../../../../lib/organization-administration/company-assets-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ organizationId: string }> },
) {
  return companyAssetsHttp(request, (await params).organizationId);
}
export const POST = GET;
