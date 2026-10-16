import { experienceHttp } from '../../../../../../lib/experience/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  return experienceHttp(request, 'provenance', (await route.params).id);
}
