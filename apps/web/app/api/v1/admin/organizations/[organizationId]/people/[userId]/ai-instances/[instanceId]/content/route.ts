import { organizationAiDirectoryHttp } from '../../../../../../../../../../../lib/organization-administration/ai-directory-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  route: {
    params: Promise<{
      organizationId: string;
      userId: string;
      instanceId: string;
    }>;
  },
) {
  const params = await route.params;
  return organizationAiDirectoryHttp(
    request,
    params.organizationId,
    params.userId,
    params.instanceId,
  );
}
