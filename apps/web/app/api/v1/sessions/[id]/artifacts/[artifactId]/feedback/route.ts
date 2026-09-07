import { artifactHttp } from '../../../../../../../../lib/runtime/artifact-http';
export const runtime = 'nodejs';
type Route = { params: Promise<{ id: string; artifactId: string }> };
export async function PUT(request: Request, route: Route) {
  const p = await route.params;
  return artifactHttp(request, 'draft', p.id, p.artifactId);
}
export async function POST(request: Request, route: Route) {
  const p = await route.params;
  return artifactHttp(request, 'submit', p.id, p.artifactId);
}
export async function PATCH(request: Request, route: Route) {
  const p = await route.params;
  return artifactHttp(request, 'address', p.id, p.artifactId);
}
