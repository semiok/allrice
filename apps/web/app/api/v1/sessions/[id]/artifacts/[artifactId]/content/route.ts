import { artifactHttp } from '../../../../../../../../lib/runtime/artifact-http';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string; artifactId: string }> },
) {
  const p = await route.params;
  return artifactHttp(request, 'content', p.id, p.artifactId);
}
