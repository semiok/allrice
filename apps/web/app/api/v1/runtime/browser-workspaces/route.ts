import { BrowserHttpRequestSchema, UuidSchema } from '@allrice/contracts';
import {
  createBrowserDirectInput,
  createBrowserOperation,
  requestBrowserControl,
  listBrowserWorkspaces,
  installBrowserControlGrant,
  revokeBrowserControlGrant,
  DataAccessError,
  RuntimePolicyError,
} from '@allrice/database';
import { requireRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
async function readBody(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new RuntimePolicyError('invalid_request');
  const reader = request.body?.getReader();
  if (!reader) throw new RuntimePolicyError('invalid_request');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 20000) {
        await reader.cancel();
        throw new RuntimePolicyError('invalid_request');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  try {
    return BrowserHttpRequestSchema.parse(JSON.parse(bytes.toString('utf8')));
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
async function handle(request: Request, write: boolean) {
  try {
    if (write && !sameOriginBrowserWrite(request))
      throw new RuntimePolicyError('origin_denied');
    const context = await requireRequestContext(request),
      url = new URL(request.url);
    const ctx = {
      ...context,
      workspaceId: UuidSchema.parse(
        url.searchParams.get('workspaceId') ?? context.workspaceId,
      ),
    };
    if (!write)
      return Response.json(
        {
          workspaces: await listBrowserWorkspaces(
            ctx,
            UuidSchema.parse(url.searchParams.get('runId')),
          ),
        },
        { headers },
      );
    const body = await readBody(request);
    let result: unknown;
    switch (body.kind) {
      case 'act': {
        const op = await createBrowserOperation(
          ctx,
          body.command,
          body.requestId,
        );
        result = {
          operationId: op.snapshot.binding.attempt.operationId,
          status: op.snapshot.status,
        };
        break;
      }
      case 'control':
        result = await requestBrowserControl(ctx, body.id, body.request);
        break;
      case 'input':
        try {
          result = await createBrowserDirectInput(ctx, body.id, body);
        } finally {
          body.value = '';
        }
        break;
      case 'grant':
        result = await installBrowserControlGrant(ctx, body);
        break;
      case 'revoke_grant':
        result = await revokeBrowserControlGrant(ctx, body.id);
        break;
    }
    return Response.json(result, { headers });
  } catch (error) {
    const status =
      error instanceof DataAccessError &&
      error.code === 'authentication_required'
        ? 401
        : (error instanceof Error && error.name === 'ZodError') ||
            error instanceof SyntaxError ||
            (error instanceof RuntimePolicyError &&
              error.code === 'invalid_request')
          ? 400
          : error instanceof RuntimePolicyError ||
              error instanceof DataAccessError
            ? 403
            : 503;
    // No request payload, validation issue or secret-derived exception in responses/logs.
    return Response.json(
      {
        error: {
          code:
            status === 400
              ? 'INVALID_REQUEST'
              : status === 401
                ? 'AUTHENTICATION_REQUIRED'
                : status === 403
                  ? 'BROWSER_DENIED'
                  : 'BROWSER_UNAVAILABLE',
          message: '浏览器操作未确认，请刷新并检查当前登录、授权和控制权。',
        },
      },
      { status, headers },
    );
  }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
