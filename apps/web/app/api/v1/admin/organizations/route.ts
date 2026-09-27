import { organizationAdministrationHttp } from '../../../../../lib/organization-administration/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  return organizationAdministrationHttp(request);
}
export async function POST(request: Request) {
  return organizationAdministrationHttp(request);
}
