import {
  ArtifactReviewError,
  workbenchEnabled,
  listWorkbenchArtifacts,
  getWorkbenchArtifact,
  listArtifactFeedback,
  saveArtifactFeedback,
  addressArtifactFeedback,
} from '@allrice/database';
import {
  WorkbenchCursorSchema,
  UuidSchema,
  runtimeStaticPreviewPolicy,
} from '@allrice/contracts';
import { getRequestContext } from '../identity/session';
import { sameOriginBrowserWrite } from '../identity/request-origin';
import { getStorageAdapter } from '../storage/runtime';
import { readStaticArtifactPreview } from './static-artifact-preview';

type RouteAction =
  'list' | 'detail' | 'content' | 'draft' | 'submit' | 'address';
const headers = {
  'Cache-Control': 'private, no-store',
  ...runtimeStaticPreviewPolicy('application/json').responseHeaders,
};
async function body(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
    throw new ArtifactReviewError('json_required');
  const reader = request.body?.getReader();
  if (!reader) throw new ArtifactReviewError('invalid_request');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 300_000) {
        await reader.cancel();
        throw new ArtifactReviewError('body_too_large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export async function artifactHttp(
  request: Request,
  action: RouteAction,
  sessionId: string,
  artifactId?: string,
) {
  if (!workbenchEnabled()) return new Response(null, { status: 404, headers });
  try {
    if (
      ['draft', 'submit', 'address'].includes(action) &&
      !sameOriginBrowserWrite(request)
    )
      return Response.json({ code: 'ORIGIN_DENIED' }, { status: 403, headers });
    const login = await getRequestContext(request);
    if (!login) return new Response(null, { status: 401, headers });
    const url = new URL(request.url),
      workspaceId = UuidSchema.parse(
        url.searchParams.get('workspaceId') ?? login.workspaceId,
      ),
      context = { ...login, workspaceId };
    UuidSchema.parse(sessionId);
    if (action === 'list') {
      const cursor = url.searchParams.get('before');
      const before = cursor
        ? WorkbenchCursorSchema.parse(JSON.parse(cursor))
        : undefined;
      return Response.json(
        await listWorkbenchArtifacts(context, sessionId, before),
        { headers },
      );
    }
    const id = UuidSchema.parse(artifactId),
      artifact = await getWorkbenchArtifact(context, sessionId, id);
    if (action === 'detail')
      return Response.json(
        {
          artifact,
          feedback: await listArtifactFeedback(context, sessionId, id),
        },
        { headers },
      );
    if (action === 'content') {
      const preview = await readStaticArtifactPreview(artifact);
      // Recheck current authorization after storage IO; bytes never grant future access.
      await getWorkbenchArtifact(context, sessionId, id);
      return Response.json(preview, { headers });
    }
    const input = await body(request);
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !('artifactId' in input) ||
      input.artifactId !== id
    )
      throw new ArtifactReviewError('artifact_mismatch');
    if (action === 'address') {
      const record = input as Record<string, unknown>;
      if (
        Object.keys(record).some(
          (k) =>
            ![
              'artifactId',
              'feedbackId',
              'resultArtifactId',
              'resolution',
            ].includes(k),
        ) ||
        typeof record.resolution !== 'string'
      )
        throw new ArtifactReviewError('invalid_request');
      const feedback = await listArtifactFeedback(context, sessionId, id);
      if (!feedback.some((f) => f.id === record.feedbackId))
        throw new ArtifactReviewError('feedback_not_found');
      return Response.json(
        {
          feedback: await addressArtifactFeedback(context, sessionId, {
            feedbackId: UuidSchema.parse(record.feedbackId),
            resultArtifactId: UuidSchema.parse(record.resultArtifactId),
            resolution: record.resolution,
          }),
        },
        { headers },
      );
    }
    return Response.json(
      {
        feedback: await saveArtifactFeedback(
          context,
          sessionId,
          input,
          action === 'submit',
          getStorageAdapter(),
        ),
      },
      { headers },
    );
  } catch (error) {
    const code =
      error instanceof ArtifactReviewError
        ? error.code
        : 'ARTIFACT_UNAVAILABLE';
    const status =
      error instanceof ArtifactReviewError
        ? /not_found/.test(code)
          ? 404
          : /identity|ORIGIN/.test(code)
            ? 403
            : /too_large/.test(code)
              ? 413
              : /conflict|changed|submitted/.test(code)
                ? 409
                : 400
        : error instanceof SyntaxError ||
            (error instanceof Error && error.name === 'ZodError')
          ? 400
          : 500;
    return Response.json({ code }, { status, headers });
  }
}
