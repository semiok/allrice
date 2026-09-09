import { UuidSchema } from '@allrice/contracts';
import {
  listLocalBrowserGrants,
  installLocalBrowserGrant,
  revokeLocalBrowserGrant,
  LocalBrowserManagementInstallSchema,
  LocalBrowserManagementRevokeSchema,
  localBrowserEnabled,
  listBridgeDevices,
  DataAccessError,
  RuntimePolicyError,
} from '@allrice/database';
import { requireRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
import { readLocalBrowserBody } from '../../../../../lib/bridge/local-browser-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
async function handle(request: Request): Promise<Response> {
  let bytes: Buffer | undefined;
  try {
    const ctx = await requireRequestContext(request);
    if (request.method === 'GET') {
      const workspaceId = UuidSchema.parse(
        new URL(request.url).searchParams.get('workspaceId'),
      );
      const current = { ...ctx, workspaceId };
      const grants = await listLocalBrowserGrants(current); // current DB admin/owner gate, even flag OFF
      const devices = (await listBridgeDevices(current, workspaceId)).filter(
        (d) => d.ownerId === ctx.actor.id && !d.revokedAt,
      );
      return Response.json(
        { enabled: localBrowserEnabled(), grants, devices },
        { headers },
      );
    }
    if (!sameOriginBrowserWrite(request))
      throw new RuntimePolicyError('origin_denied');
    bytes = await readLocalBrowserBody(request, 16384, 'application/json');
    const raw = JSON.parse(bytes.toString('utf8'));
    if (request.method === 'POST') {
      const { workspaceId, ...body } =
        LocalBrowserManagementInstallSchema.parse(raw);
      return Response.json(
        await installLocalBrowserGrant({ ...ctx, workspaceId }, body),
        { status: 201, headers },
      );
    }
    const body = LocalBrowserManagementRevokeSchema.parse(raw);
    return Response.json(
      await revokeLocalBrowserGrant(
        { ...ctx, workspaceId: body.workspaceId },
        body.grantId,
      ),
      { headers },
    );
  } catch (error) {
    const status =
      error instanceof DataAccessError &&
      error.code === 'authentication_required'
        ? 401
        : error instanceof SyntaxError ||
            (error instanceof Error && error.name === 'ZodError')
          ? 400
          : error instanceof RuntimePolicyError ||
              error instanceof DataAccessError
            ? 403
            : 503;
    return Response.json(
      {
        error: {
          code: 'LOCAL_BROWSER_UNAVAILABLE',
          message: '操作未确认，请检查当前租户、管理员身份和设备授权。',
        },
      },
      { status, headers },
    );
  } finally {
    bytes?.fill(0);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
