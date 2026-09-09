import {
  createExperienceStore,
  experienceReviewEnabled,
  ExperienceError,
} from '@allrice/database';
import { UuidSchema } from '@allrice/contracts';
import { isRequestValidationError } from '../api-error-response';
import { getRequestContext } from '../identity/session';
import { sameOriginBrowserWrite } from '../identity/request-origin';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
};
async function body(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new SyntaxError();
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 40_000) {
        await reader.cancel();
        throw new SyntaxError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function experienceHttp(
  request: Request,
  action: 'list' | 'sources' | 'create' | 'review',
  id?: string,
) {
  if (!experienceReviewEnabled())
    return new Response(null, { status: 404, headers });
  try {
    if (
      ['create', 'review'].includes(action) &&
      !sameOriginBrowserWrite(request)
    )
      return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
    const login = await getRequestContext(request);
    if (!login) return new Response(null, { status: 401, headers });
    const url = new URL(request.url);
    const workspaceId = UuidSchema.parse(
      url.searchParams.get('workspaceId') ?? login.workspaceId,
    );
    const context = { ...login, workspaceId };
    const store = createExperienceStore();
    if (action === 'list')
      return Response.json(
        { candidates: await store.list(context) },
        { headers },
      );
    if (action === 'sources')
      return Response.json(
        {
          sources: await store.sources(
            context,
            UuidSchema.parse(url.searchParams.get('sessionId')),
          ),
        },
        { headers },
      );
    const input = await body(request);
    const candidate =
      action === 'create'
        ? await store.create(context, input)
        : await store.review(context, UuidSchema.parse(id), input);
    return Response.json(
      { candidate },
      { status: action === 'create' ? 201 : 200, headers },
    );
  } catch (error) {
    const code =
      error instanceof ExperienceError
        ? error.code
        : isRequestValidationError(error)
          ? 'invalid_request'
          : 'unavailable';
    const status =
      code === 'not_found' || code === 'disabled'
        ? 404
        : code === 'conflict' || code === 'source_changed'
          ? 409
          : code === 'identity_denied' ||
              code === 'platform_publication_required'
            ? 403
            : code === 'invalid_request' || code === 'invalid_source'
              ? 400
              : 503;
    return Response.json({ code }, { status, headers });
  }
}
