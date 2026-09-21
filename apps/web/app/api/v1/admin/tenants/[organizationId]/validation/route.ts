import { tenantValidationHttp } from '../../../../../../../lib/tenant-administration/validation-http';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ organizationId: string }> },
) {
  return tenantValidationHttp(request, (await route.params).organizationId);
}
