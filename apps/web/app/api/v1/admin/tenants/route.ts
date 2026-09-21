import { tenantAdministrationHttp } from '../../../../../lib/tenant-administration/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => tenantAdministrationHttp(request);
