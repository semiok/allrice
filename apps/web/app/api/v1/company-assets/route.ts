import { companyAssetsHttp } from '../../../../lib/organization-administration/company-assets-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET(request: Request) {
  return companyAssetsHttp(request);
}
export const POST = GET;
