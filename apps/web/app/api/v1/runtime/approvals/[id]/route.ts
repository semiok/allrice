import {
  DataAccessError,
  decideRuntimeActionApproval,
  getRuntimeActionApproval,
  revokeRuntimeActionApproval,
  RuntimePolicyError,
} from '@allrice/database';

import { capabilityErrorResponse } from '../../../../../../lib/capabilities/responses';
import { isRequestValidationError } from '../../../../../../lib/api-error-response';
import { getRequestContext } from '../../../../../../lib/identity/session';

export const runtime = 'nodejs';
type Params = { params: Promise<{ id: string }> };
const headers = { 'Cache-Control': 'no-store' };

async function readDecision(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new RuntimePolicyError('json_required');
  const reader = request.body?.getReader();
  if (!reader) throw new RuntimePolicyError('body_required');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65_536) {
        await reader.cancel();
        throw new RuntimePolicyError('request_too_large');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function handle(
  request: Request,
  params: Params,
  action: 'read' | 'decide' | 'revoke',
) {
  // Server-owned opt-in only. Enabling an endpoint does NOT enable any policy or Runner.
  if (process.env.ALLRICE_RUNTIME_POLICY_ENABLED !== '1')
    return new Response(null, { status: 404, headers });
  try {
    const context = await getRequestContext(request);
    if (!context) throw new DataAccessError('authentication_required');
    const { id } = await params.params;
    if (action === 'read')
      return Response.json(
        { approval: await getRuntimeActionApproval(context, id) },
        { headers },
      );
    if (action === 'revoke')
      return Response.json(await revokeRuntimeActionApproval(context, id), {
        headers,
      });
    if (Number(request.headers.get('content-length') ?? 0) > 65_536)
      return Response.json(
        { code: 'REQUEST_TOO_LARGE' },
        { status: 413, headers },
      );
    return Response.json(
      {
        approval: await decideRuntimeActionApproval(
          context,
          id,
          await readDecision(request),
        ),
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof SyntaxError)
      return Response.json({ code: 'INVALID_JSON' }, { status: 400, headers });
    if (error instanceof RuntimePolicyError)
      return Response.json(
        { code: error.code },
        {
          status:
            error.code === 'approval_not_found'
              ? 404
              : error.code === 'request_too_large'
                ? 413
                : 403,
          headers,
        },
      );
    if (error instanceof DataAccessError || isRequestValidationError(error)) {
      const response = capabilityErrorResponse(error);
      response.headers.set('Cache-Control', 'no-store');
      return response;
    }
    // Database/adapter failures may contain internal inputs; never serialize or log them here.
    return Response.json({ code: 'INTERNAL_ERROR' }, { status: 500, headers });
  }
}

export const GET = (request: Request, params: Params) =>
  handle(request, params, 'read');
export const POST = (request: Request, params: Params) =>
  handle(request, params, 'decide');
export const DELETE = (request: Request, params: Params) =>
  handle(request, params, 'revoke');
