import { artifactHttp } from '../../../../../../lib/runtime/artifact-http';
export const runtime = 'nodejs';
export async function GET(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  return artifactHttp(request, 'list', (await route.params).id);
}
