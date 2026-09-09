import { experienceHttp } from '../../../../../../lib/experience/http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  return experienceHttp(request, 'review', (await route.params).id);
}
