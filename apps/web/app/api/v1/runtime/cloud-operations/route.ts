import {
  listCloudRuntimeOperations,
  cancelCloudRuntimeRun,
  RuntimePolicyError,
  DataAccessError,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { requireRequestContext } from '../../../../../lib/identity/session';
import { sameOriginBrowserWrite } from '../../../../../lib/identity/request-origin';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
async function cancelBody(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new RuntimePolicyError('invalid_request');
  const reader = request.body?.getReader();
  if (!reader) throw new RuntimePolicyError('invalid_request');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 2048) {
        await reader.cancel();
        throw new RuntimePolicyError('invalid_request');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RuntimePolicyError('invalid_request');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'action,runId' ||
    (value as { action: unknown }).action !== 'cancel'
  )
    throw new RuntimePolicyError('invalid_request');
  const parsed = UuidSchema.safeParse((value as { runId: unknown }).runId);
  if (!parsed.success) throw new RuntimePolicyError('invalid_request');
  return parsed.data;
}
async function handle(request: Request, cancel: boolean) {
  try {
    if (cancel && !sameOriginBrowserWrite(request))
      throw new RuntimePolicyError('origin_denied');
    const context = await requireRequestContext(request),
      url = new URL(request.url);
    const workspace = UuidSchema.safeParse(
      url.searchParams.get('workspaceId') ?? context.workspaceId,
    );
    const run = UuidSchema.safeParse(
      cancel ? await cancelBody(request) : url.searchParams.get('runId'),
    );
    if (!workspace.success || !run.success)
      throw new RuntimePolicyError('invalid_request');
    const scoped = { ...context, workspaceId: workspace.data };
    return Response.json(
      cancel
        ? await cancelCloudRuntimeRun(scoped, run.data)
        : { operations: await listCloudRuntimeOperations(scoped, run.data) },
      { headers },
    );
  } catch (error) {
    const status =
      error instanceof DataAccessError &&
      error.code === 'authentication_required'
        ? 401
        : error instanceof RuntimePolicyError &&
            error.code === 'invalid_request'
          ? 400
          : error instanceof RuntimePolicyError ||
              error instanceof DataAccessError
            ? 403
            : 503;
    return Response.json(
      {
        error: {
          code:
            status === 401
              ? 'AUTHENTICATION_REQUIRED'
              : status === 400
                ? 'INVALID_REQUEST'
                : status === 403
                  ? 'OPERATION_DENIED'
                  : 'OPERATION_UNAVAILABLE',
          message: '无法读取或处理此运行，请检查登录和工作区权限后刷新。',
        },
      },
      { status, headers },
    );
  }
}
export const GET = (request: Request) => handle(request, false);
export const POST = (request: Request) => handle(request, true);
