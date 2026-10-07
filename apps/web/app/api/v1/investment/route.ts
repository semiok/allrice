import { investmentHttp } from '../../../../lib/organization-administration/investment-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return investmentHttp(request);
}
export const POST = GET;
